import { createHash } from 'node:crypto'

export default {
  createPassword (password) {
    return createHash('sha512').update(password, 'utf8').digest('hex')
  }
}
