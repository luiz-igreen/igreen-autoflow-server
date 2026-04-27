async function generateGeminiContent(imageBuffer, prompt, mimeType = 'image/jpeg') {
  const API_KEY = process.env.GEMINI_API_KEY;

  // Strict validation
  if (!API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
  }
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error('Image buffer is null, not a Buffer, or empty');
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('Prompt is required and must be a non-empty string');
  }

  const base64Image = imageBuffer.toString('base64');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;

  // Detailed log with masked API key
  const maskedKey = API_KEY.length > 10 ? `${API_KEY.slice(0, 3)}...${API_KEY.slice(-4)}` : '***';
  const loggedUrl = `${url.split('?')[0]}?key=${maskedKey}`;
  console.log('Calling Gemini API URL:', loggedUrl);
  console.log('Request payload size:', JSON.stringify({ contents: [{ parts: [{ text: prompt.length > 50 ? prompt.slice(0, 50) + '...' : prompt, inlineData: { mimeType, data: base64Image.length > 50 ? base64Image.slice(0, 50) + '...' : base64Image } } ] } }).length, 'bytes');

  const requestBody = {
    contents: [{
      parts: [
        { text: prompt },
        {
          inlineData: {
            mimeType,
            data: base64Image
          }
        }
      ]
    }]
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini API error ${response.status}:`, errorText);
      throw new Error(`Gemini API request failed with status ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = await response.json();
    console.log('Gemini API response received successfully');
    return data;
  } catch (error) {
    console.error('Error in Gemini API call:', error.message);
    throw error;
  }
}

// Example usage:
// const result = await generateGeminiContent(imageBuffer, 'Describe this image in detail.');
// console.log(result.candidates[0].content.parts[0].text);
