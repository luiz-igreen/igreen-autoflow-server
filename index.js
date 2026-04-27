const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

// Environment variables
const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_FLASH_KEY = process.env.GEMINI_FLASH_KEY;
const GEMINI_PRO_KEY = process.env.GEMINI_PRO_KEY;
const FLASH_MODEL = 'gemini-2.0-flash-exp';
const PRO_MODEL = 'gemini-2.0-pro-exp';

// Logging function
const log = (msg) => {
  console.log(`[${new Date().toISOString()}] ${msg}`);
};

// OCR Prompt
const OCR_PROMPT = `Extract all text from the provided image using OCR. Handle challenges such as shadows, blurs, low resolution, partial cuts, occlusions, or poor lighting. Be as accurate and complete as possible. Ignore any non-text elements.

Respond ONLY with valid JSON in this exact format: {"text": "the full extracted text here", "completeness": 0.95}

Where 'completeness' is a float from 0.0 to 1.0 estimating how complete and reliable the text extraction is (1.0 = perfect, no missing parts).`;

// Axios instance with defaults
const apiClient = axios.create({
  timeout: 60000,
  headers: { 'Content-Type': 'application/json' }
});

const whatsappClient = axios.create({
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' }
});

// Express app
const app = express();
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook handler (POST)
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      await handleWhatsAppEvent(body.entry[0].changes[0].value);
    }
    res.sendStatus(200);
  } catch (error) {
    log(`Webhook error: ${error.message}`);
    res.sendStatus(500);
  }
});

// Handle WhatsApp events
async function handleWhatsAppEvent(value) {
  const messages = value.messages;
  if (!messages || !Array.isArray(messages)) return;

  for (const message of messages) {
    if (message.type === 'image') {
      await processImage(message);
    }
  }
}

// Process image message
async function processImage(message) {
  const from = message.from;
  const mediaId = message.image.id;
  const msgId = message.id;

  log(`Processing image from ${from}, mediaId: ${mediaId}`);

  try {
    const imageBuffer = await downloadMedia(mediaId);
    const ocrResult = await performOCR(imageBuffer);
    await auditToFirebase({ from, msgId, ...ocrResult });

    const reply = `OCR Result:
${ocrResult.text}

Completeness: ${(ocrResult.completeness * 100).toFixed(1)}%
Model: ${ocrResult.model.toUpperCase()}`;

    await sendMessage(from, reply);
    log(`Sent OCR result to ${from}`);
  } catch (error) {
    log(`Error processing image ${mediaId}: ${error.message}`);
    await sendMessage(from, 'Sorry, there was an error processing the image. Please try again.');
  }
}

// Download media from WhatsApp
async function downloadMedia(mediaId) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media/${mediaId}`;
  const response = await whatsappClient.get(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: 'arraybuffer'
  });
  return Buffer.from(response.data);
}

// Perform OCR with Flash first, retry, fallback to Pro
async function performOCR(imageBuffer) {
  const base64Image = imageBuffer.toString('base64');

  // Try Flash up to 3 times
  let result;
  for (let attempt = 1; attempt <= 3; attempt++) {
    result = await callGemini(base64Image, GEMINI_FLASH_KEY, FLASH_MODEL);
    result.model = 'flash';
    log(`Flash attempt ${attempt}, completeness: ${(result.completeness * 100).toFixed(1)}%`);
    if (result.completeness >= 0.8) {
      return result;
    }
  }

  // Fallback to Pro
  log('Falling back to Pro model');
  result = await callGemini(base64Image, GEMINI_PRO_KEY, PRO_MODEL);
  result.model = 'pro';
  log(`Pro completeness: ${(result.completeness * 100).toFixed(1)}%`);
  return result;
}

// Call Gemini API
async function callGemini(base64Image, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{
      parts: [
        { text: OCR_PROMPT },
        {
          inline_data: {
            mime_type: 'image/jpeg',
            data: base64Image
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: 'application/json'
    }
  };

  const response = await apiClient.post(url, payload);
  const generatedText = response.data.candidates[0].content.parts[0].text;

  // Parse JSON
  let parsed;
  try {
    parsed = JSON.parse(generatedText);
  } catch (e) {
    throw new Error(`Invalid JSON from Gemini: ${generatedText}`);
  }

  if (!parsed.text || typeof parsed.completeness !== 'number') {
    throw new Error('Invalid response structure from Gemini');
  }

  return {
    text: parsed.text,
    completeness: Math.max(0, Math.min(1, parsed.completeness)) // Clamp 0-1
  };
}

// Send message via WhatsApp
async function sendMessage(to, text) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  await whatsappClient.post(url, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  }, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });
}

// Audit to Firebase
async function auditToFirebase(data) {
  await db.collection('ocr_audits').add({
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    phone: data.from,
    msgId: data.msgId,
    model: data.model,
    text: data.text,
    completeness: data.completeness,
    createdAt: new Date().toISOString()
  });
  log(`Audited to Firebase: ${data.msgId}`);
}

// Start server
app.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
});
