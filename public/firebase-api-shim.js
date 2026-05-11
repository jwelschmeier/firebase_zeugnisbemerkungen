(function () {
  function callFunction(functionName, args) {
    return fetch('/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ functionName: functionName, args: args || [] })
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok || payload.error) {
          throw new Error(payload.error || ('HTTP ' + response.status));
        }
        return payload.result;
      });
    });
  }

  function runner(successHandler, failureHandler) {
    return new Proxy({}, {
      get: function (_target, prop) {
        if (prop === 'withSuccessHandler') {
          return function (handler) { return runner(handler, failureHandler); };
        }
        if (prop === 'withFailureHandler') {
          return function (handler) { return runner(successHandler, handler); };
        }
        return function () {
          var args = Array.prototype.slice.call(arguments);
          callFunction(String(prop), args)
            .then(function (result) {
              if (typeof successHandler === 'function') successHandler(result);
            })
            .catch(function (error) {
              if (typeof failureHandler === 'function') failureHandler(error.message || String(error));
              else console.error(error);
            });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = runner();
})();
