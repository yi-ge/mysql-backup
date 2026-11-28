import type { ComponentPropsWithoutRef } from 'react'

function submit (form: HTMLFormElement, button: HTMLButtonElement) {
  if (!button.disabled && (button.formNoValidate || form.noValidate || form.reportValidity())) {
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: button }))
  }
}

export function ActionForm (props: ComponentPropsWithoutRef<'form'>) {
  return <form {...props} onClick={event => {
    const button = (event.target as Element).closest('button')
    if (!button || button.type !== 'submit' || button.form !== event.currentTarget) return
    // DesireCore Web sandboxes native form navigation. Validated actions use fetch.
    event.preventDefault()
    submit(event.currentTarget, button)
  }} onKeyDown={event => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || !(event.target instanceof HTMLInputElement)) return
    if (!['text', 'email', 'password', 'number', 'search', 'tel', 'url'].includes(event.target.type)) return
    const button = event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]')
    if (!button) return
    event.preventDefault()
    submit(event.currentTarget, button)
  }}/>
}
