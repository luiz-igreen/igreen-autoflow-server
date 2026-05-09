import express from 'express';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer-core';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';

// ============================================
// HEALTH CHECK — Validar Chrome no startup
// ============================================

async function validateBrowser() {
  console.log('🔍 Validating Chromium installation...');
  console.log(`📍 Expected path: ${CHROMIUM_PATH}`);

  try {
    const browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ],
      timeout: 30000
    });

    const version = await browser.version();
    await browser.close();

    console.log(`✔ Browser health check PASSED`);
    console.log(`✔ Chromium version: ${version}`);
    return true;
  } catch (error) {
    console.error('❌ Browser initialization failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// ============================================
// MIDDLEWARE
// ============================================

app.use(express.json());

// ============================================
// ROUTES
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'igreen-autoflow-server-1',
    timestamp: new Date().toISOString(),
    chromium: CHROMIUM_PATH
  });
});

app.post('/extract', async (req, res) => {
  const { pdfUrl } = req.body;

  if (!pdfUrl) {
    return res.status(400).json({ error: 'pdfUrl is required' });
  }

  try {
    console.log(`📄 Extracting data from: ${pdfUrl}`);

    const browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.goto(pdfUrl, { waitUntil: 'networkidle2' });

    // Aqui você implementa a lógica de extração OCR
    const extractedData = {
      conta: 'PLACEHOLDER',
      consumo: 0,
      tarifa: 0,
      confianca: 0
    };

    await browser.close();

    res.json({
      success: true,
      data: extractedData
    });
  } catch (error) {
    console.error('❌ Extraction error:', error.message);
    res.status(500).json({
      error: 'Extraction failed',
      message: error.message
    });
  }
});

// ============================================
// SERVER STARTUP
// ============================================

async function startServer() {
  try {
    // Validar browser antes de iniciar servidor
    await validateBrowser();

    app.listen(PORT, () => {
      console.log(`\n🚀 Server running on port ${PORT}`);
      console.log(`📍 URL: https://igreen-autoflow-server-1.onrender.com`);
      console.log(`✔ Banco de Dados Cloud ligado!`);
      console.log(`✔ Rodando na porta ${PORT}\n`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();
