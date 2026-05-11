(function () {
  var ALLOWED_DOMAIN = 'realschule-hoevelhof.de';
  var currentUser = null;
  var readyCallbacks = [];
  var initialAuthResolved = false;

  function safeEmail(user) {
    return String((user && user.email) || '').trim().toLowerCase();
  }

  function isAllowedUser(user) {
    var email = safeEmail(user);
    return Boolean(user && user.emailVerified !== false && email.endsWith('@' + ALLOWED_DOMAIN));
  }

  function appContent() {
    return document.getElementById('app-content');
  }

  function setNavVisible(visible) {
    var navWrap = document.querySelector('.nav.nav-pills');
    if (navWrap) navWrap.style.display = visible ? '' : 'none';
  }

  function renderLogin(message) {
    setNavVisible(false);
    var target = appContent();
    if (!target) return;
    target.innerHTML = [
      '<div class="text-center py-5">',
      '  <div class="mx-auto mb-4" style="max-width:420px;">',
      '    <h2 class="h4 text-light mb-3">Anmeldung erforderlich</h2>',
      '    <p class="text-muted mb-4">Bitte mit dem schulischen Google-Konto anmelden.</p>',
      message ? '    <div class="alert alert-warning text-start">' + escapeHtml(message) + '</div>' : '',
      '    <button type="button" class="btn btn-primary" id="googleSignInBtn">',
      '      <i class="fa-brands fa-google me-2"></i> Mit Google anmelden',
      '    </button>',
      '  </div>',
      '</div>'
    ].join('');
    var button = document.getElementById('googleSignInBtn');
    if (button) button.addEventListener('click', signIn);
  }

  function renderDenied(email) {
    renderLogin('Dieses Konto ist nicht freigeschaltet: ' + email + '. Erlaubt sind nur Konten mit @' + ALLOWED_DOMAIN + '.');
  }

  function escapeHtml(input) {
    return String(input || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function signIn() {
    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ hd: ALLOWED_DOMAIN, prompt: 'select_account' });
    firebase.auth().signInWithPopup(provider).catch(function (error) {
      if (error && error.code === 'auth/popup-blocked') {
        return firebase.auth().signInWithRedirect(provider);
      }
      renderLogin((error && error.message) || 'Anmeldung fehlgeschlagen.');
    });
  }

  window.signOutFirebase = function () {
    return firebase.auth().signOut();
  };

  window.getFirebaseAuthToken = function () {
    if (!currentUser) return Promise.reject(new Error('Bitte zuerst anmelden.'));
    return currentUser.getIdToken();
  };

  window.onAuthStateReady = function (callback) {
    if (initialAuthResolved) callback(currentUser);
    else readyCallbacks.push(callback);
  };

  firebase.auth().onAuthStateChanged(function (user) {
    var email = safeEmail(user);
    initialAuthResolved = true;
    if (user && isAllowedUser(user)) {
      currentUser = user;
      setNavVisible(true);
      readyCallbacks.splice(0).forEach(function (callback) { callback(currentUser); });
    } else {
      currentUser = null;
      if (user) {
        firebase.auth().signOut().finally(function () { renderDenied(email); });
      } else {
        renderLogin();
      }
      readyCallbacks.splice(0).forEach(function (callback) { callback(null); });
    }
  });
})();
