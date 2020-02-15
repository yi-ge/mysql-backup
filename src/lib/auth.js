import JsSHA from 'jssha'

export default {
  createPassword (password) {
    const shaObj = new JsSHA('SHA-512', 'TEXT')
    shaObj.update(password)
    const hash = shaObj.getHash('HEX')
    return hash
  }
}
