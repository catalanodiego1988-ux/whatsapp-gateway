const puppeteer = require('puppeteer');

(async () => {
  try {
    console.log('Intentando lanzar navegador...');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox']
    });
    console.log('Navegador lanzado correctamente!');
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('Error lanzando navegador:', err);
    process.exit(1);
  }
})();
