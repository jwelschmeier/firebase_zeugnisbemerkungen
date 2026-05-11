const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');

const include = (name) => fs.readFileSync(path.join(publicDir, `${name}.html`), 'utf8');

let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
html = html.replace('<base target="_top">\n', '');
html = html.replace("<?!= include('style'); ?>", include('style'));
html = html.replace(
  "<?!= include('js-core'); ?>",
  '<script src="/firebase-api-shim.js"></script>\n' + include('js-core')
);

for (const name of ['js-proposals-core', 'js-proposals', 'js-teacher', 'js-admin']) {
  html = html.replace(`<?!= include('${name}'); ?>`, include(name));
}

fs.writeFileSync(path.join(publicDir, 'index.html'), html);
