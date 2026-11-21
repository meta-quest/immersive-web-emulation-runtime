// Uncaught error in a task (WRK-7): reaches the Worker as an ErrorEvent with a location.
setTimeout(function boom() {
  throw new TypeError('worker failure on purpose');
}, 0);
