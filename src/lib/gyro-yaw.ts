// Single source of truth for the device's gyro→yaw calibration.
//
// THE LEARNING (validated 2026-05-29/30; see site/scripts/analysis/heading-comparison/):
// To get a tilt-independent yaw (heading) rate from the phone, project the body-frame
// angular velocity onto the world-up axis (from gravity). The catch is the device-frame
// AXIS ASSIGNMENT — which rotationRate field is rotation about which body axis. For this
// device (iPhone, Chrome iOS — see memory reference_user_iphone_env) it is empirically:
//
//     ωx (about X) = alpha     ωy (about Y) = beta     ωz (about Z) = gamma
//
// This is NOT the naïve W3C mapping (ωx=beta, ωy=gamma, ωz=alpha) that earlier code
// assumed. cmp8.py swept every assignment against a translation-robust camera-truth
// (linear rotational-flow optical flow): the W3C assignment scored ~0 correlation, this
// one scored +0.96 / +0.91 on two independent recordings. Using the wrong assignment is
// the root cause of the long-standing "yaw misbehaves" bug in AD and the calibrator.
//
// Why the gyro at all: against the same camera-truth the gyro matches real rotation at
// corr 0.96–0.99, while the magnetometer compass matches at only 0.26 and is directionally
// WRONG indoors (magnetic interference). So heading should come from the gyro; the compass
// is at best a slow drift-anchor. (project memory: project_gyro_is_yaw_source)
//
// DEVICE-SPECIFIC: this assignment is calibrated for the user's iPhone. Other devices may
// differ and need their own profile — re-run the of4.py/cmp8.py study per device.
// (project memory: project_calibrator_future — multi-device testing is filed for later.)

/** rotationRate as stored by both onMotion handlers: rad/s, ra=alpha, rb=beta, rg=−gamma. */
export interface StoredRotationRate {
  ra: number;
  rb: number;
  rg: number;
}

export interface GravityVec {
  x: number;
  y: number;
  z: number;
}

/**
 * World-up yaw rate in rad/s, compass-style CW (positive = turning right, matching
 * webkitCompassHeading's direction). Tilt-independent: valid at any phone orientation.
 *
 * Derivation (validated assignment ωx=alpha=ra, ωy=beta=rb, ωz=gamma=−rg; up = −g/|g|):
 *   ω·up projected and re-signed to compass-CW reduces to (ra·gx + rb·gy − rg·gz)/|g|.
 * Integrate as `yaw += worldUpYawRateCompassCW(...) * dt` (+ matches compass direction,
 * verified corr +1.00 on the clean recording).
 */
export function worldUpYawRateCompassCW(rr: StoredRotationRate, g: GravityVec): number {
  const gmag = Math.hypot(g.x, g.y, g.z) || 1;
  return (rr.ra * g.x + rr.rb * g.y - rr.rg * g.z) / gmag;
}
