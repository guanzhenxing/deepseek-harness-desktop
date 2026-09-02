// Recovery view renderer: no inline scripts (CSP), no network, text-only DOM.
;(function () {
  'use strict'

  function setText(id, text) {
    var node = document.getElementById(id)
    if (node !== null) node.textContent = String(text)
  }

  function render(view) {
    setText('failure-stage', view.failure.stage)
    setText('failure-code', view.failure.code)
    setText('failure-summary', view.failure.summary)
    var retry = document.getElementById('action-retry')
    if (retry !== null) {
      retry.disabled = !view.retryAllowed
      retry.style.display = view.retryAllowed ? '' : 'none'
    }
    var safe = document.getElementById('action-safe-mode')
    if (safe !== null) {
      safe.disabled = !view.safeModeAllowed
      safe.style.display = view.safeModeAllowed ? '' : 'none'
    }
    var doctor = document.getElementById('doctor-command')
    if (doctor !== null) {
      doctor.style.display = view.doctorCommand === null ? 'none' : ''
      setText('doctor-command-text', view.doctorCommand)
    }
  }

  function bind(id, action) {
    var node = document.getElementById(id)
    if (node === null) return
    node.addEventListener('click', function () {
      window.dshRecovery.requestAction(action)
    })
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind('action-retry', 'retry')
    bind('action-safe-mode', 'safe-mode')
    bind('action-quit', 'quit')
    window.dshRecovery.onView(render)
  })
})()
