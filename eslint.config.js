import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['src/ui/**', 'src/template/**'] },
  js.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }]
    }
  }
]
