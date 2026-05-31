// Landing page: the project name and a link to the calibrator — nothing else.
// Any description or framing of the project is the owner's to write, not ours.
const app = document.querySelector<HTMLElement>('#app')

if (app) {
  const h1 = document.createElement('h1')
  h1.textContent = 'web-ar-instrument'

  const p = document.createElement('p')
  const link = document.createElement('a')
  link.href = '/calibrator.html'
  link.textContent = 'Open the calibrator'
  p.appendChild(link)

  app.append(h1, p)
}
