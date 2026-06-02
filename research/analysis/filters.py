"""
Offline simulation harness for AR orientation filters.

Loads recordings, runs each candidate filter against the raw sensor stream,
emits per-sample bearing output. Ground truth for the bundled example captures
is a fixed reference compass bearing held throughout (see `ref_bearing`).

All filters operate on a merged event stream (orientation + motion), output a
quaternion representing the camera-to-world rotation (three.js convention:
camera looks down -Z, world = (+X east, +Y up, -Z north)).

Convention note on iOS sensors:
- DeviceOrientationEvent: alpha/beta/gamma in degrees, webkitCompassHeading in
  degrees. accelerationIncludingGravity is the GRAVITY VECTOR ITSELF pointing
  toward Earth (vertical phone → gy ≈ -9.8), per empirical verification.
- DeviceMotionEvent.rotationRate: alpha/beta/gamma in deg/s per W3C spec,
  around DEVICE body-frame axes (Z=out-of-screen, X=top-bottom, Y=left-right).
"""
import json
import math
import time
from dataclasses import dataclass, field

import numpy as np

DEG = math.pi / 180


def q_normalize(q):
    n = math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3])
    if n < 1e-12:
        return (0.0, 0.0, 0.0, 1.0)
    return (q[0]/n, q[1]/n, q[2]/n, q[3]/n)


def q_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw*bx + ax*bw + ay*bz - az*by,
        aw*by - ax*bz + ay*bw + az*bx,
        aw*bz + ax*by - ay*bx + az*bw,
        aw*bw - ax*bx - ay*by - az*bz,
    )


def q_from_axis_angle(ax, ay, az, angle_rad):
    h = angle_rad * 0.5
    s = math.sin(h)
    return (ax*s, ay*s, az*s, math.cos(h))


def q_apply_inverse(q, vx, vy, vz):
    """Rotate vector by q^-1 → camera-local frame."""
    qx, qy, qz, qw = q
    # v' = q^-1 * v * q
    # Using optimized formula for quaternion-vector rotation with conjugate
    tx = 2 * (qy*vz - qz*vy)
    ty = 2 * (qz*vx - qx*vz)
    tz = 2 * (qx*vy - qy*vx)
    return (
        vx - qw*tx + (qy*tz - qz*ty),
        vy - qw*ty + (qz*tx - qx*tz),
        vz - qw*tz + (qx*ty - qy*tx),
    )


def matrix_to_quat(m00, m01, m02, m10, m11, m12, m20, m21, m22):
    trace = m00 + m11 + m22
    if trace > 0:
        s = 0.5 / math.sqrt(trace + 1)
        return (
            (m21 - m12) * s,
            (m02 - m20) * s,
            (m10 - m01) * s,
            0.25 / s,
        )
    elif m00 > m11 and m00 > m22:
        s = 2 * math.sqrt(1 + m00 - m11 - m22)
        return (
            0.25 * s,
            (m01 + m10) / s,
            (m02 + m20) / s,
            (m21 - m12) / s,
        )
    elif m11 > m22:
        s = 2 * math.sqrt(1 + m11 - m00 - m22)
        return (
            (m01 + m10) / s,
            0.25 * s,
            (m12 + m21) / s,
            (m02 - m20) / s,
        )
    else:
        s = 2 * math.sqrt(1 + m22 - m00 - m11)
        return (
            (m02 + m20) / s,
            (m12 + m21) / s,
            0.25 * s,
            (m10 - m01) / s,
        )


def quat_to_bearing(q):
    """
    Given a camera-to-world quaternion (three.js convention: world {+X=E, +Y=U, -Z=N}),
    return the camera-forward bearing in DEGREES (0=North, 90=East).
    Camera-forward in camera-local = (0, 0, -1). Rotate to world.
    """
    qx, qy, qz, qw = q
    # camera-forward world = q * (0,0,-1) * q^-1 — i.e., apply q
    # Using v' = v + 2*q.xyz × (q.xyz × v + q.w * v)
    vx, vy, vz = 0.0, 0.0, -1.0
    tx = 2 * (qy*vz - qz*vy)
    ty = 2 * (qz*vx - qx*vz)
    tz = 2 * (qx*vy - qy*vx)
    wx = vx + qw*tx + (qy*tz - qz*ty)
    wy = vy + qw*ty + (qz*tx - qx*tz)
    wz = vz + qw*tz + (qx*ty - qy*tx)
    # bearing = atan2(east, north) = atan2(+X, -Z)
    bearing = math.degrees(math.atan2(wx, -wz))
    if bearing < 0:
        bearing += 360
    return bearing


# === Algorithms ===

class EulerGamma:
    """Existing: iOS Euler with the -γ correction."""
    name = "euler-gamma"
    def __init__(self): pass
    def update(self, o, m):
        if o is None: return None
        alpha = (360 - o['compass'] - o['gamma']) * DEG
        beta = o['beta'] * DEG
        gamma = o['gamma'] * DEG
        sa, ca = math.sin(alpha/2), math.cos(alpha/2)
        sb, cb = math.sin(beta/2), math.cos(beta/2)
        sg, cg = math.sin(-gamma/2), math.cos(-gamma/2)
        # ZXY intrinsic
        qa = (0, 0, sa, ca)
        qb = (sb, 0, 0, cb)
        qg = (0, sg, 0, cg)
        q = q_mul(q_mul(qa, qb), qg)
        # Rx(-π/2)
        s = math.sin(-math.pi/4); c = math.cos(-math.pi/4)
        q = q_mul(q, (s, 0, 0, c))
        # screen orient (assume 0)
        return q_normalize(q)


class GravityCompass:
    """Existing: gravity + compass."""
    name = "gravity-compass"
    def __init__(self): pass
    def update(self, o, m):
        if m is None or o is None: return None
        gx, gy, gz = m['gx'], m['gy'], m['gz']
        gmag = math.sqrt(gx*gx + gy*gy + gz*gz)
        if gmag < 0.1: return None
        ux, uy, uz = -gx/gmag, -gy/gmag, -gz/gmag
        # project phone +Y onto plane ⊥ up
        pyDotU = uy
        px = -pyDotU * ux
        py = 1 - pyDotU * uy
        pz = -pyDotU * uz
        pmag = math.sqrt(px*px + py*py + pz*pz)
        if pmag < 0.05:
            pzDotU = -uz
            qx_ = 0 - pzDotU * ux
            qy_ = 0 - pzDotU * uy
            qz_ = -1 - pzDotU * uz
            qmag = math.sqrt(qx_*qx_ + qy_*qy_ + qz_*qz_)
            if qmag < 0.05: return None
            perp = (qx_/qmag, qy_/qmag, qz_/qmag)
        else:
            perp = (px/pmag, py/pmag, pz/pmag)
        cRad = o['compass'] * DEG
        cosC = math.cos(cRad); sinC = math.sin(cRad)
        kDotV = ux*perp[0] + uy*perp[1] + uz*perp[2]
        kxvX = uy*perp[2] - uz*perp[1]
        kxvY = uz*perp[0] - ux*perp[2]
        kxvZ = ux*perp[1] - uy*perp[0]
        nx = perp[0]*cosC + kxvX*sinC + ux*kDotV*(1-cosC)
        ny = perp[1]*cosC + kxvY*sinC + uy*kDotV*(1-cosC)
        nz = perp[2]*cosC + kxvZ*sinC + uz*kDotV*(1-cosC)
        ex = ny*uz - nz*uy
        ey = nz*ux - nx*uz
        ez = nx*uy - ny*ux
        return q_normalize(matrix_to_quat(ex, ey, ez, ux, uy, uz, -nx, -ny, -nz))


def _compass_is_reliable(o, last_rot_mag):
    """Heuristic gate: compass usable when phone isn't in the bad zone.

    iOS webkitCompassHeading degrades primarily as a function of roll γ alone
    (not β). At |γ| > 35° error grows fast; at |γ| > 60° errors of 50°+ are
    typical. Also reject when compass accuracy is bad or angular motion is fast
    (compass needs settling time)."""
    if o is None: return False
    if o.get('compassAcc', -1) < 0: return False
    if o.get('compassAcc', 100) > 25: return False
    if abs(o['gamma']) > 15: return False  # tightened from 35 (empirical)
    if last_rot_mag > 120: return False  # fast motion
    return True


class CompassGated:
    """
    Gravity + gated compass with gyro-integrated yaw carry-through.

    Algorithm:
      1. Compute roll+pitch attitude from gravity vector (always reliable when stationary-ish).
      2. If compass is reliable, blend its yaw into current yaw (low-pass, α=0.05/sample at 60Hz).
      3. If compass is unreliable, advance yaw using gyro integration (high-pass).
      4. Smooth the resulting quaternion.

    State: a yaw scalar (heading the device +Y projection should track) and last good gravity.
    """
    name = "compass-gated"
    def __init__(self):
        self.yaw = None         # current world-frame yaw (radians), where +Y projection points
        self.last_t = None
        self.last_rot_mag = 0
        self.alpha_compass = 0.15  # weight to apply to compass each sample when reliable

    def update(self, o, m):
        # If motion sample, just track gyro magnitude for the gate
        if m is not None:
            self.last_rot_mag = math.sqrt(m['ra']**2 + m['rb']**2 + m['rg']**2)
        if o is None or m is None: return None
        gx, gy, gz = m['gx'], m['gy'], m['gz']
        gmag = math.sqrt(gx*gx + gy*gy + gz*gz)
        if gmag < 0.1: return None
        # Up in phone frame
        ux, uy, uz = -gx/gmag, -gy/gmag, -gz/gmag

        # Time step
        t = o['t']
        if self.last_t is None:
            dt = 1/60
        else:
            dt = max(1e-3, min(0.1, t - self.last_t))
        self.last_t = t

        # Phone +Y projected onto horizontal plane in WORLD frame: we need the heading the
        # phone +Y axis points (or fall back to -Z) — same as iOS compass convention.
        pyDotU = uy
        px = -pyDotU * ux
        py = 1 - pyDotU * uy
        pz = -pyDotU * uz
        pmag = math.sqrt(px*px + py*py + pz*pz)
        if pmag < 0.05:
            pzDotU = -uz
            px = 0 - pzDotU * ux
            py = 0 - pzDotU * uy
            pz = -1 - pzDotU * uz
            pmag = math.sqrt(px*px + py*py + pz*pz)
            if pmag < 0.05: return None
        perp = (px/pmag, py/pmag, pz/pmag)  # this is the direction phone-+Y (or -Z fallback) points in PHONE frame, projected onto plane ⊥ up

        # Compass yaw input (radians, world frame: where phone +Y is pointing)
        compass_yaw = o['compass'] * DEG
        # If first sample, initialize yaw to compass (if reliable) else 0
        if self.yaw is None:
            if _compass_is_reliable(o, self.last_rot_mag):
                self.yaw = compass_yaw
            else:
                self.yaw = compass_yaw  # initialize anyway; will correct on first good sample
        else:
            # Advance yaw using body-frame angular velocity projected onto world-up
            # Body angular velocity vector ω_body = (rot.beta, rot.gamma, rot.alpha) in
            # device axes (X=top-bot, Y=left-right, Z=out-of-screen).
            wx_body = m['rb'] * DEG
            wy_body = m['rg'] * DEG
            wz_body = m['ra'] * DEG
            # World-up in PHONE-frame is (ux, uy, uz). Component of ω around world-up:
            yaw_rate = wx_body*ux + wy_body*uy + wz_body*uz  # rad/s
            self.yaw -= yaw_rate * dt
            # Optional compass correction (low-pass) when reliable
            if _compass_is_reliable(o, self.last_rot_mag):
                # Take shortest-path delta between yaw and compass_yaw
                delta = (compass_yaw - self.yaw + math.pi) % (2*math.pi) - math.pi
                self.yaw += self.alpha_compass * delta

        # Rebuild quaternion from up + yaw (same shape as gravity-compass but with our own yaw)
        cRad = self.yaw
        cosC = math.cos(cRad); sinC = math.sin(cRad)
        kDotV = ux*perp[0] + uy*perp[1] + uz*perp[2]
        kxvX = uy*perp[2] - uz*perp[1]
        kxvY = uz*perp[0] - ux*perp[2]
        kxvZ = ux*perp[1] - uy*perp[0]
        nx = perp[0]*cosC + kxvX*sinC + ux*kDotV*(1-cosC)
        ny = perp[1]*cosC + kxvY*sinC + uy*kDotV*(1-cosC)
        nz = perp[2]*cosC + kxvZ*sinC + uz*kDotV*(1-cosC)
        ex = ny*uz - nz*uy
        ey = nz*ux - nx*uz
        ez = nx*uy - ny*ux
        return q_normalize(matrix_to_quat(ex, ey, ez, ux, uy, uz, -nx, -ny, -nz))


class GyroAnchored:
    """
    Control: gravity gives attitude, yaw locked to first reliable compass reading,
    then carried forward by gyro integration only. No compass updates after lock.
    Bounds the gyro drift over a 30s session.
    """
    name = "gyro-anchored"
    def __init__(self):
        self.yaw = None
        self.last_t = None
        self.last_rot_mag = 0
        self.locked = False

    def update(self, o, m):
        if m is not None:
            self.last_rot_mag = math.sqrt(m['ra']**2 + m['rb']**2 + m['rg']**2)
        if o is None or m is None: return None
        gx, gy, gz = m['gx'], m['gy'], m['gz']
        gmag = math.sqrt(gx*gx + gy*gy + gz*gz)
        if gmag < 0.1: return None
        ux, uy, uz = -gx/gmag, -gy/gmag, -gz/gmag

        t = o['t']
        if self.last_t is None: dt = 1/60
        else: dt = max(1e-3, min(0.1, t - self.last_t))
        self.last_t = t

        if not self.locked:
            if _compass_is_reliable(o, self.last_rot_mag) and abs(o['gamma']) < 15:
                self.yaw = o['compass'] * DEG
                self.locked = True
            else:
                self.yaw = o['compass'] * DEG  # provisional
        else:
            wx_body = m['rb'] * DEG
            wy_body = m['rg'] * DEG
            wz_body = m['ra'] * DEG
            yaw_rate = wx_body*ux + wy_body*uy + wz_body*uz
            self.yaw -= yaw_rate * dt

        # Build quat (same as CompassGated)
        pyDotU = uy
        px = -pyDotU * ux
        py = 1 - pyDotU * uy
        pz = -pyDotU * uz
        pmag = math.sqrt(px*px + py*py + pz*pz)
        if pmag < 0.05:
            pzDotU = -uz
            px = -pzDotU * ux
            py = -pzDotU * uy
            pz = -1 - pzDotU * uz
            pmag = math.sqrt(px*px + py*py + pz*pz)
            if pmag < 0.05: return None
        perp = (px/pmag, py/pmag, pz/pmag)
        cRad = self.yaw
        cosC = math.cos(cRad); sinC = math.sin(cRad)
        kDotV = ux*perp[0] + uy*perp[1] + uz*perp[2]
        kxvX = uy*perp[2] - uz*perp[1]
        kxvY = uz*perp[0] - ux*perp[2]
        kxvZ = ux*perp[1] - uy*perp[0]
        nx = perp[0]*cosC + kxvX*sinC + ux*kDotV*(1-cosC)
        ny = perp[1]*cosC + kxvY*sinC + uy*kDotV*(1-cosC)
        nz = perp[2]*cosC + kxvZ*sinC + uz*kDotV*(1-cosC)
        ex = ny*uz - nz*uy
        ey = nz*ux - nx*uz
        ez = nx*uy - ny*ux
        return q_normalize(matrix_to_quat(ex, ey, ez, ux, uy, uz, -nx, -ny, -nz))


class Mahony:
    """
    Mahony PI complementary filter. Body-frame gyro integrated to a quaternion,
    with proportional + integral correction from accelerometer (gravity ref) and
    optional magnetometer (compass-derived) toward world reference.
    """
    name = "mahony"
    def __init__(self, Kp=2.0, Ki=0.05, gate_mag=True):
        self.q = (0.0, 0.0, 0.0, 1.0)
        self.bx = self.by = self.bz = 0.0
        self.Kp = Kp
        self.Ki = Ki
        self.last_t = None
        self.last_rot_mag = 0
        self.gate_mag = gate_mag
        self.initialized = False

    def update(self, o, m):
        if m is not None:
            self.last_rot_mag = math.sqrt(m['ra']**2 + m['rb']**2 + m['rg']**2)
        if o is None or m is None: return None
        if not self.initialized:
            seed = GravityCompass().update(o, m)
            if seed is not None:
                self.q = seed
                self.initialized = True
            else:
                return None
        t = o['t']
        if self.last_t is None: dt = 1/60
        else: dt = max(1e-3, min(0.1, t - self.last_t))
        self.last_t = t

        # Measured gravity direction in body frame (unit vector, points DOWN since
        # iOS accelerationIncludingGravity is the gravity vector itself).
        gx, gy, gz = m['gx'], m['gy'], m['gz']
        gmag = math.sqrt(gx*gx + gy*gy + gz*gz)
        if gmag < 0.1: return self.q
        ax, ay, az = gx/gmag, gy/gmag, gz/gmag

        # Body-frame gyro (rad/s). iOS rotationRate: alpha=Z, beta=X, gamma=Y, in deg/s.
        wx = m["rb"] * DEG
        wy = m["rg"] * DEG
        wz = m["ra"] * DEG

        # Predicted gravity direction in body frame = q^-1 * world-down (0,-1,0).
        gx_p, gy_p, gz_p = q_apply_inverse(self.q, 0.0, -1.0, 0.0)

        # Error vector: predicted × measured (right-hand rule rotates p toward m).
        ex = gy_p*az - gz_p*ay
        ey = gz_p*ax - gx_p*az
        ez = gx_p*ay - gy_p*ax

        # Compass correction (when gated open): represent the YAW disagreement as
        # a rotation around world-up axis (expressed in body frame).
        use_mag = (not self.gate_mag) or _compass_is_reliable(o, self.last_rot_mag)
        if use_mag:
            # Predicted compass = bearing of phone +Y in world.
            py_w_x = (1 - 2*(self.q[2]**2 + self.q[0]**2)) * 0 + 2*(self.q[0]*self.q[1] + self.q[3]*self.q[2]) * 1 + 2*(self.q[0]*self.q[2] - self.q[3]*self.q[1]) * 0
            # cleaner: actually apply q to (0,1,0)
            tmp = q_mul(q_mul(self.q, (0.0, 1.0, 0.0, 0.0)), (-self.q[0], -self.q[1], -self.q[2], self.q[3]))
            wpx, _, wpz = tmp[0], tmp[1], tmp[2]
            predicted = math.degrees(math.atan2(wpx, -wpz))
            if predicted < 0: predicted += 360
            delta = ((o['compass'] - predicted + 540) % 360) - 180
            # World-up in body frame: u_body = -predicted_gravity (since predicted gravity is world-DOWN in body).
            ux_b, uy_b, uz_b = -gx_p, -gy_p, -gz_p
            yaw_err = delta * DEG  # signed
            ex += ux_b * yaw_err
            ey += uy_b * yaw_err
            ez += uz_b * yaw_err

        # PI bias correction
        self.bx += self.Ki * ex * dt
        self.by += self.Ki * ey * dt
        self.bz += self.Ki * ez * dt
        wx += self.Kp * ex + self.bx
        wy += self.Kp * ey + self.by
        wz += self.Kp * ez + self.bz

        # Quaternion integration
        qx, qy, qz, qw = self.q
        dqx = 0.5 * (qw*wx + qy*wz - qz*wy)
        dqy = 0.5 * (qw*wy - qx*wz + qz*wx)
        dqz = 0.5 * (qw*wz + qx*wy - qy*wx)
        dqw = 0.5 * (-qx*wx - qy*wy - qz*wz)
        self.q = q_normalize((qx + dqx*dt, qy + dqy*dt, qz + dqz*dt, qw + dqw*dt))
        return self.q


class Madgwick:
    """
    Madgwick MARG filter — analytic gradient toward (gravity, compass) reference.
    Adapted to our convention: world Y up, accel is gravity vector (so 'down' = -Y_world),
    magnetic reference via compass yaw (no raw mag vector).
    """
    name = "madgwick"
    def __init__(self, beta=0.04, gate_mag=True):
        self.q = (0.0, 0.0, 0.0, 1.0)
        self.beta = beta
        self.last_t = None
        self.last_rot_mag = 0
        self.gate_mag = gate_mag
        self.initialized = False

    def update(self, o, m):
        if m is not None:
            self.last_rot_mag = math.sqrt(m['ra']**2 + m['rb']**2 + m['rg']**2)
        if o is None or m is None: return None
        if not self.initialized:
            seed = GravityCompass().update(o, m)
            if seed is not None:
                self.q = seed
                self.initialized = True
            else:
                return None
        t = o['t']
        if self.last_t is None: dt = 1/60
        else: dt = max(1e-3, min(0.1, t - self.last_t))
        self.last_t = t

        gx, gy, gz = m['gx'], m['gy'], m['gz']
        gmag = math.sqrt(gx*gx + gy*gy + gz*gz)
        if gmag < 0.1: return self.q
        ax, ay, az = gx/gmag, gy/gmag, gz/gmag

        wx = m["rb"] * DEG
        wy = m["rg"] * DEG
        wz = m["ra"] * DEG

        # Borrow Mahony's structure but use larger beta gain (gradient-style step).
        gx_p, gy_p, gz_p = q_apply_inverse(self.q, 0.0, -1.0, 0.0)
        # Cross product: predicted × measured (rotation axis to align p with m).
        ex = gy_p*az - gz_p*ay
        ey = gz_p*ax - gx_p*az
        ez = gx_p*ay - gy_p*ax

        use_mag = (not self.gate_mag) or _compass_is_reliable(o, self.last_rot_mag)
        if use_mag:
            tmp = q_mul(q_mul(self.q, (0.0, 1.0, 0.0, 0.0)), (-self.q[0], -self.q[1], -self.q[2], self.q[3]))
            wpx, _, wpz = tmp[0], tmp[1], tmp[2]
            predicted = math.degrees(math.atan2(wpx, -wpz))
            if predicted < 0: predicted += 360
            delta = ((o['compass'] - predicted + 540) % 360) - 180
            ux_b, uy_b, uz_b = -gx_p, -gy_p, -gz_p
            yaw_err = delta * DEG
            ex += ux_b * yaw_err
            ey += uy_b * yaw_err
            ez += uz_b * yaw_err

        # Madgwick subtracts a normalized gradient step from the gyro qdot.
        mag = math.sqrt(ex*ex + ey*ey + ez*ez)
        if mag > 1e-9:
            ex /= mag; ey /= mag; ez /= mag
        wx -= self.beta * ex / DEG  # beta gain in rad/s units consistent with wx
        wy -= self.beta * ey / DEG
        wz -= self.beta * ez / DEG

        qx, qy, qz, qw = self.q
        dqx = 0.5 * (qw*wx + qy*wz - qz*wy)
        dqy = 0.5 * (qw*wy - qx*wz + qz*wx)
        dqz = 0.5 * (qw*wz + qx*wy - qy*wx)
        dqw = 0.5 * (-qx*wx - qy*wy - qz*wz)
        self.q = q_normalize((qx + dqx*dt, qy + dqy*dt, qz + dqz*dt, qw + dqw*dt))
        return self.q
        ax, ay, az = gx/gmag, gy/gmag, gz/gmag

        wx = m['rb'] * DEG
        wy = m['rg'] * DEG
        wz = m['ra'] * DEG

        qx, qy, qz, qw = self.q

        # Gradient step for gravity alignment (accel says where world-DOWN is in body)
        # Predicted body-frame down = q^-1 * (0,-1,0)
        # Objective f = predicted_down - measured_accel_direction
        gx_p, gy_p, gz_p = q_apply_inverse(self.q, 0, -1, 0)
        f1 = gx_p - ax
        f2 = gy_p - ay
        f3 = gz_p - az
        # Jacobian J of f wrt q (4x3)
        # df1/dq = (-2*qy, 2*qz, -2*qw, 2*qx)? — standard Madgwick form expanded
        # Use the standard derivation:
        J11 = -2*qz
        J12 =  2*qw
        J13 = -2*qx
        J14 =  2*qy
        J21 = -2*qw  # actually for f2 = qx*qy - qz*qw rearrangement... use closed form below
        # NOTE: using shorthand. For correctness, use the published Madgwick gradient.
        # Implementing a simplified form:
        # ∇F = J^T * f, where for gravity alignment with world-down (0,-1,0):
        # Standard Madgwick (Y up convention):
        # f_g = [2(qx qy - qw qz) - ax, 2(qw qx + qy qz) - ay, 2(0.5 - qx² - qz²) - az]  (or similar)
        # For simplicity, use a numerical jacobian via per-axis perturbation
        eps = 1e-6
        def predicted_down(q_):
            return q_apply_inverse(q_, 0, -1, 0)
        f = (f1, f2, f3)
        grad = [0.0, 0.0, 0.0, 0.0]
        for i, ax_q in enumerate([(1,0,0,0),(0,1,0,0),(0,0,1,0),(0,0,0,1)]):
            qp = (qx + eps*ax_q[0], qy + eps*ax_q[1], qz + eps*ax_q[2], qw + eps*ax_q[3])
            fp = predicted_down(qp)
            for j in range(3):
                grad[i] += (fp[j] - (gx_p, gy_p, gz_p)[j]) / eps * f[j]
        # Normalize gradient
        gmag2 = math.sqrt(sum(g*g for g in grad))
        if gmag2 > 1e-12:
            grad = [g/gmag2 for g in grad]

        # Magnetometer step (if usable) — use compass yaw error analogously to Mahony
        use_mag = (not self.gate_mag) or _compass_is_reliable(o, self.last_rot_mag)
        # For now, skip the mag step in Madgwick and rely on compass correction by yaw delta
        # similar to what we did in Mahony, applied to gradient outside.

        # Gyro-derived qdot
        dqx = 0.5 * (qw*wx + qy*wz - qz*wy)
        dqy = 0.5 * (qw*wy - qx*wz + qz*wx)
        dqz = 0.5 * (qw*wz + qx*wy - qy*wx)
        dqw = 0.5 * (-qx*wx - qy*wy - qz*wz)

        # Subtract gradient step
        dqx -= self.beta * grad[0]
        dqy -= self.beta * grad[1]
        dqz -= self.beta * grad[2]
        dqw -= self.beta * grad[3]

        nq = q_normalize((qx + dqx*dt, qy + dqy*dt, qz + dqz*dt, qw + dqw*dt))

        # Yaw correction toward gated compass (separate small step)
        if use_mag:
            # Predicted compass = bearing of phone +Y in world
            tmp = list(nq)
            qx2, qy2, qz2, qw2 = nq
            # apply q to (0,1,0)
            vx, vy, vz = 0.0, 1.0, 0.0
            tx = 2 * (qy2*vz - qz2*vy)
            ty = 2 * (qz2*vx - qx2*vz)
            tz = 2 * (qx2*vy - qy2*vx)
            wpx = vx + qw2*tx + (qy2*tz - qz2*ty)
            wpz = vz + qw2*tz + (qx2*ty - qy2*tx)
            predicted_compass = math.degrees(math.atan2(wpx, -wpz))
            if predicted_compass < 0: predicted_compass += 360
            delta = ((o['compass'] - predicted_compass + 540) % 360) - 180
            # Rotate small amount around world-up to correct
            up_rot = q_from_axis_angle(0, 1, 0, delta * DEG * 0.05)
            nq = q_mul(up_rot, nq)
            nq = q_normalize(nq)

        self.q = nq
        return self.q


class TiltCompensatedCompass:
    """
    Classic tilt-compensated compass + gravity. No gyro, no gate, but uses the standard
    rotation-of-magnetometer-into-horizontal-plane trick. Since we don't have raw mag,
    use compass heading as-is but only when projection of phone+Y onto horizontal is
    well-defined (|pyDotU|<0.7), otherwise hold the last quaternion.
    """
    name = "tilt-compensated"
    def __init__(self):
        self.last_q = None

    def update(self, o, m):
        if o is None or m is None: return self.last_q
        gx, gy, gz = m['gx'], m['gy'], m['gz']
        gmag = math.sqrt(gx*gx + gy*gy + gz*gz)
        if gmag < 0.1: return self.last_q
        ux, uy, uz = -gx/gmag, -gy/gmag, -gz/gmag
        if abs(uy) > 0.92:  # phone is so vertical that compass projection is degenerate
            return self.last_q  # hold last
        # Use existing gravity-compass logic
        q = GravityCompass().update(o, m)
        if q is not None:
            self.last_q = q
        return self.last_q




class CompassPredictiveGated(CompassGated):
    """Compass-gated, but ALSO rejects compass samples when they disagree with
    the gyro-integrated yaw by more than a threshold. Catches the iOS flips
    that happen even outside the |γ|>15° zone (the smoking gun: at γ=-20° the
    compass can still flip momentarily). Threshold ~20°."""
    name = "compass-predictive"
    def __init__(self):
        super().__init__()
        self.alpha_compass = 0.25
        self.disagreement_threshold_rad = 20 * DEG

    def update(self, o, m):
        if m is not None:
            self.last_rot_mag = math.sqrt(m['ra']**2 + m['rb']**2 + m['rg']**2)
        if o is None or m is None: return None
        # First-time init from compass directly
        gx, gy, gz = m['gx'], m['gy'], m['gz']
        gmag = math.sqrt(gx*gx + gy*gy + gz*gz)
        if gmag < 0.1: return None
        ux, uy, uz = -gx/gmag, -gy/gmag, -gz/gmag

        t = o['t']
        if self.last_t is None: dt = 1/60
        else: dt = max(1e-3, min(0.1, t - self.last_t))
        self.last_t = t

        pyDotU = uy
        px = -pyDotU * ux
        py = 1 - pyDotU * uy
        pz = -pyDotU * uz
        pmag = math.sqrt(px*px + py*py + pz*pz)
        if pmag < 0.05:
            pzDotU = -uz
            px = -pzDotU * ux
            py = -pzDotU * uy
            pz = -1 - pzDotU * uz
            pmag = math.sqrt(px*px + py*py + pz*pz)
            if pmag < 0.05: return None
        perp = (px/pmag, py/pmag, pz/pmag)

        compass_yaw = o['compass'] * DEG
        if self.yaw is None:
            self.yaw = compass_yaw
        else:
            # Always integrate gyro to advance yaw
            wx_body = m["rb"] * DEG
            wy_body = m["rg"] * DEG
            wz_body = m["ra"] * DEG
            yaw_rate = wx_body*ux + wy_body*uy + wz_body*uz
            self.yaw -= yaw_rate * dt
            # Conditional compass correction — must be in gate AND agree with prediction
            if _compass_is_reliable(o, self.last_rot_mag):
                delta = (compass_yaw - self.yaw + math.pi) % (2*math.pi) - math.pi
                if abs(delta) < self.disagreement_threshold_rad:
                    self.yaw += self.alpha_compass * delta

        cRad = self.yaw
        cosC = math.cos(cRad); sinC = math.sin(cRad)
        kDotV = ux*perp[0] + uy*perp[1] + uz*perp[2]
        kxvX = uy*perp[2] - uz*perp[1]
        kxvY = uz*perp[0] - ux*perp[2]
        kxvZ = ux*perp[1] - uy*perp[0]
        nx = perp[0]*cosC + kxvX*sinC + ux*kDotV*(1-cosC)
        ny = perp[1]*cosC + kxvY*sinC + uy*kDotV*(1-cosC)
        nz = perp[2]*cosC + kxvZ*sinC + uz*kDotV*(1-cosC)
        ex = ny*uz - nz*uy
        ey = nz*ux - nx*uz
        ez = nx*uy - ny*ux
        return q_normalize(matrix_to_quat(ex, ey, ez, ux, uy, uz, -nx, -ny, -nz))


class AccuracyWeightedCompass(CompassGated):
    """Compass weight scales with reliability rather than binary gate:
       full weight at γ=0, zero weight at γ=45°, smooth blend in between."""
    name = "accuracy-weighted"
    def __init__(self):
        super().__init__()

    def update(self, o, m):
        if m is not None:
            self.last_rot_mag = math.sqrt(m['ra']**2 + m['rb']**2 + m['rg']**2)
        if o is None or m is None: return None
        gx, gy, gz = m['gx'], m['gy'], m['gz']
        gmag = math.sqrt(gx*gx + gy*gy + gz*gz)
        if gmag < 0.1: return None
        ux, uy, uz = -gx/gmag, -gy/gmag, -gz/gmag

        t = o['t']
        if self.last_t is None: dt = 1/60
        else: dt = max(1e-3, min(0.1, t - self.last_t))
        self.last_t = t

        pyDotU = uy
        px = -pyDotU * ux
        py = 1 - pyDotU * uy
        pz = -pyDotU * uz
        pmag = math.sqrt(px*px + py*py + pz*pz)
        if pmag < 0.05:
            pzDotU = -uz
            px = -pzDotU * ux
            py = -pzDotU * uy
            pz = -1 - pzDotU * uz
            pmag = math.sqrt(px*px + py*py + pz*pz)
            if pmag < 0.05: return None
        perp = (px/pmag, py/pmag, pz/pmag)

        compass_yaw = o['compass'] * DEG
        if self.yaw is None:
            self.yaw = compass_yaw
        else:
            wx_body = m["rb"] * DEG
            wy_body = m["rg"] * DEG
            wz_body = m["ra"] * DEG
            yaw_rate = wx_body*ux + wy_body*uy + wz_body*uz
            self.yaw -= yaw_rate * dt
            # Weight: 1.0 at |γ|<10°, 0 at |γ|>40°, linear ramp between.
            g_abs = abs(o['gamma'])
            if g_abs < 10:
                weight = 1.0
            elif g_abs > 40:
                weight = 0.0
            else:
                weight = (40 - g_abs) / 30.0
            # Down-weight by rotation rate magnitude (compass needs settling)
            if self.last_rot_mag > 60:
                weight *= max(0.0, 1.0 - (self.last_rot_mag - 60) / 60)
            # Down-weight by compass accuracy report
            acc = o.get('compassAcc', 10)
            if acc < 0 or acc > 25:
                weight = 0.0
            if weight > 0.001:
                delta = (compass_yaw - self.yaw + math.pi) % (2*math.pi) - math.pi
                # Cap per-step correction
                MAX_STEP = 8 * DEG
                if abs(delta) > 30*DEG:
                    pass  # reject sketchy big delta
                else:
                    correction = max(-MAX_STEP, min(MAX_STEP, weight * 0.3 * delta))
                    self.yaw += correction

        cRad = self.yaw
        cosC = math.cos(cRad); sinC = math.sin(cRad)
        kDotV = ux*perp[0] + uy*perp[1] + uz*perp[2]
        kxvX = uy*perp[2] - uz*perp[1]
        kxvY = uz*perp[0] - ux*perp[2]
        kxvZ = ux*perp[1] - uy*perp[0]
        nx = perp[0]*cosC + kxvX*sinC + ux*kDotV*(1-cosC)
        ny = perp[1]*cosC + kxvY*sinC + uy*kDotV*(1-cosC)
        nz = perp[2]*cosC + kxvZ*sinC + uz*kDotV*(1-cosC)
        ex = ny*uz - nz*uy
        ey = nz*ux - nx*uz
        ez = nx*uy - ny*ux
        return q_normalize(matrix_to_quat(ex, ey, ez, ux, uy, uz, -nx, -ny, -nz))


class CompassGatedGammaCorrected:
    """The yaw input from compass is corrected by subtracting γ before use.

    iOS webkitCompassHeading reports the heading of phone +Y projection onto the
    horizontal plane. At high γ on a vertical phone, +Y projection rotates around
    camera-forward, so its heading drifts off camera-forward direction by ~γ.
    The prior-session fix (compass - γ) recovers true camera-forward bearing.

    We integrate gyro-projected-onto-world-up to advance the yaw state across the
    unreliable-compass moments, and snap to (compass - γ) when compass is reliable.
    """
    name = "compass-gated-gamma"
    def __init__(self):
        self.yaw = None
        self.last_t = None
        self.last_rot_mag = 0
        self.alpha_compass = 0.15

    def update(self, o, m):
        if m is not None:
            self.last_rot_mag = math.sqrt(m['ra']**2 + m['rb']**2 + m['rg']**2)
        if o is None or m is None: return None
        gx, gy, gz = m['gx'], m['gy'], m['gz']
        gmag = math.sqrt(gx*gx + gy*gy + gz*gz)
        if gmag < 0.1: return None
        ux, uy, uz = -gx/gmag, -gy/gmag, -gz/gmag

        t = o['t']
        if self.last_t is None: dt = 1/60
        else: dt = max(1e-3, min(0.1, t - self.last_t))
        self.last_t = t

        pyDotU = uy
        px = -pyDotU * ux
        py = 1 - pyDotU * uy
        pz = -pyDotU * uz
        pmag = math.sqrt(px*px + py*py + pz*pz)
        if pmag < 0.05:
            pzDotU = -uz
            px = -pzDotU * ux
            py = -pzDotU * uy
            pz = -1 - pzDotU * uz
            pmag = math.sqrt(px*px + py*py + pz*pz)
            if pmag < 0.05: return None
        perp = (px/pmag, py/pmag, pz/pmag)

        # γ-corrected target yaw: subtract γ from compass to recover camera-forward bearing.
        corrected_compass = (o['compass'] - o['gamma']) % 360
        corrected_yaw = corrected_compass * DEG

        if self.yaw is None:
            self.yaw = corrected_yaw
        else:
            wx_body = m["rb"] * DEG
            wy_body = m["rg"] * DEG
            wz_body = m["ra"] * DEG
            yaw_rate = wx_body*ux + wy_body*uy + wz_body*uz
            self.yaw -= yaw_rate * dt
            if _compass_is_reliable(o, self.last_rot_mag):
                delta = (corrected_yaw - self.yaw + math.pi) % (2*math.pi) - math.pi
                self.yaw += self.alpha_compass * delta

        # Build attitude as gravity-compass does, but using yaw as the heading anchor for perp.
        cRad = self.yaw
        cosC = math.cos(cRad); sinC = math.sin(cRad)
        kDotV = ux*perp[0] + uy*perp[1] + uz*perp[2]
        kxvX = uy*perp[2] - uz*perp[1]
        kxvY = uz*perp[0] - ux*perp[2]
        kxvZ = ux*perp[1] - uy*perp[0]
        nx = perp[0]*cosC + kxvX*sinC + ux*kDotV*(1-cosC)
        ny = perp[1]*cosC + kxvY*sinC + uy*kDotV*(1-cosC)
        nz = perp[2]*cosC + kxvZ*sinC + uz*kDotV*(1-cosC)
        ex = ny*uz - nz*uy
        ey = nz*ux - nx*uz
        ez = nx*uy - ny*ux
        return q_normalize(matrix_to_quat(ex, ey, ez, ux, uy, uz, -nx, -ny, -nz))


class EulerGammaGated:
    """euler-gamma's instant compass-γ correction, gated by reliability, with
    gyro-yaw carry-through. Simplest formulation: store yaw_state = (compass - γ)
    at last reliable moment, advance via gyro projection on world-up between
    reliable samples.

    Note: the gyro-integration of "yaw of camera-forward" is non-trivial when phone
    is far from vertical. For vertical-phone usage this matches the wrist-roll
    perception. For face-up/face-down this degrades gracefully back to compass.
    """
    name = "euler-gamma-gated"
    def __init__(self):
        self.yaw = None
        self.last_t = None
        self.last_rot_mag = 0
        self.alpha_compass = 0.20

    def update(self, o, m):
        if m is not None:
            self.last_rot_mag = math.sqrt(m['ra']**2 + m['rb']**2 + m['rg']**2)
        if o is None or m is None: return None
        gx, gy, gz = m['gx'], m['gy'], m['gz']
        gmag = math.sqrt(gx*gx + gy*gy + gz*gz)
        if gmag < 0.1: return None
        ux, uy, uz = -gx/gmag, -gy/gmag, -gz/gmag

        t = o['t']
        if self.last_t is None: dt = 1/60
        else: dt = max(1e-3, min(0.1, t - self.last_t))
        self.last_t = t

        # Target: use full euler-gamma attitude as instant anchor.
        # For yaw, we want the alpha that euler-gamma uses: (360 - compass - γ).
        target_alpha = (360 - o['compass'] - o['gamma']) * DEG

        if self.yaw is None:
            self.yaw = target_alpha
        else:
            wx_body = m["rb"] * DEG
            wy_body = m["rg"] * DEG
            wz_body = m["ra"] * DEG
            yaw_rate = wx_body*ux + wy_body*uy + wz_body*uz
            self.yaw += yaw_rate * dt  # NOTE: alpha sign is opposite from compass-yaw
            if _compass_is_reliable(o, self.last_rot_mag):
                delta = (target_alpha - self.yaw + math.pi) % (2*math.pi) - math.pi
                self.yaw += self.alpha_compass * delta

        # Now build attitude using euler-gamma structure with our yaw_state as alpha:
        alphaRad = self.yaw
        betaRad = o['beta'] * DEG
        gammaRad = o['gamma'] * DEG
        sa, ca = math.sin(alphaRad/2), math.cos(alphaRad/2)
        sb, cb = math.sin(betaRad/2), math.cos(betaRad/2)
        sg, cg = math.sin(-gammaRad/2), math.cos(-gammaRad/2)
        qa = (0, 0, sa, ca)
        qb = (sb, 0, 0, cb)
        qg = (0, sg, 0, cg)
        q = q_mul(q_mul(qa, qb), qg)
        s = math.sin(-math.pi/4); c = math.cos(-math.pi/4)
        q = q_mul(q, (s, 0, 0, c))
        return q_normalize(q)


class CompassGatedTight(CompassGated):
    """Same as CompassGated but with tighter gamma threshold and stronger compass weight when open."""
    name = "compass-gated-tight"
    def __init__(self):
        super().__init__()
        self.alpha_compass = 0.30

def _compass_is_reliable_tight(o, last_rot_mag):
    if o is None: return False
    if o.get('compassAcc', -1) < 0: return False
    if o.get('compassAcc', 100) > 20: return False
    if abs(o['gamma']) > 25: return False
    if last_rot_mag > 100: return False
    return True

# === Driver ===

@dataclass
class SimResult:
    name: str
    rec_id: str
    timestamps_s: np.ndarray
    bearings_deg: np.ndarray
    beta: np.ndarray
    gamma: np.ndarray
    update_time_us: float


def load_recording(rec_id):
    d = json.load(open(f'/tmp/gizmo-recordings/rec_{rec_id}.json'))
    samples = d['samples']
    # Merge into a single time-sorted stream of events, each event is (t, kind, payload)
    events = []
    for s in samples:
        t = s['t'] / 1000.0
        if s['kind'] == 'o':
            events.append((t, 'o', {
                't': t,
                'alpha': s['alpha'],
                'beta': s['beta'],
                'gamma': s['gamma'],
                'compass': s['webkitCompassHeading'],
                'compassAcc': s.get('webkitCompassAccuracy', -1),
            }))
        elif s['kind'] == 'm':
            r = s['rot']
            ag = s['accG']
            events.append((t, 'm', {
                't': t,
                'gx': ag['x'], 'gy': ag['y'], 'gz': ag['z'],
                'ra': r['a'], 'rb': r['b'], 'rg': -r['g'],  # iOS rot.g sign-flipped empirically
            }))
    events.sort(key=lambda e: e[0])
    return d, events


def simulate(filt_cls, rec_id, **kwargs):
    d, events = load_recording(rec_id)
    filt = filt_cls(**kwargs)
    bearings = []
    ts = []
    betas = []
    gammas = []
    last_o = None
    t_start = time.perf_counter()
    update_calls = 0
    for t, kind, payload in events:
        if kind == 'o':
            last_o = payload
            q = filt.update(payload, getattr(filt, '_last_m', None))
        else:
            filt._last_m = payload
            q = filt.update(last_o, payload)
        update_calls += 1
        if q is not None and last_o is not None and kind == 'o':
            bearings.append(quat_to_bearing(q))
            ts.append(t)
            betas.append(last_o['beta'])
            gammas.append(last_o['gamma'])
    elapsed = time.perf_counter() - t_start
    return SimResult(
        name=filt.name,
        rec_id=rec_id,
        timestamps_s=np.array(ts),
        bearings_deg=np.array(bearings),
        beta=np.array(betas),
        gamma=np.array(gammas),
        update_time_us=elapsed / max(1, update_calls) * 1e6,
    )


if __name__ == '__main__':
    import sys
    recs = ['1c3e4e1s', '6z0p0r2q']
    filters = [EulerGamma, GravityCompass, CompassGated, CompassGatedGammaCorrected, EulerGammaGated, GyroAnchored]
    print(f"{'algo':<22} {'rec':>10} {'µs/upd':>8}  {'err@upright':>12} {'err@γ>+60':>10} {'err@γ<-60':>10}")
    for cls in filters:
        for rec in recs:
            r = simulate(cls, rec)
            # error vs the fixed reference bearing for the example captures
            err = ((r.bearings_deg - 335 + 540) % 360) - 180
            up_mask = (np.abs(r.gamma) < 15) & (r.beta > 70)
            pr_mask = r.gamma > 60
            nr_mask = r.gamma < -60
            def stat(mask):
                if mask.sum() == 0: return ' --   '
                e = err[mask]
                return f'{np.mean(e):+5.0f}±{np.std(e):3.0f}'
            print(f"{r.name:<22} {rec:>10} {r.update_time_us:>7.1f}  {stat(up_mask):>12} {stat(pr_mask):>10} {stat(nr_mask):>10}")
