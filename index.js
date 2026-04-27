// 🧠 MOTOR IA DEFINITIVO E ATUALIZADO (Fatura)
async function auditarFaturaIA(base64, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("Chave Gemini ausente!");
  
  // A URL E MODELO EXATOS QUE VOCÊ DESCOBRIU
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `
    Aja como um auditor rigoroso da iGreen.
    ATENÇÃO MÁXIMA: O documento anexo PODE SER UMA FOTO DE UMA TELA DE COMPUTADOR. Isso é 100% VÁLIDO. 
    Desde que a imagem contenha dados de energia de uma concessionária (Equatorial, Cemig, Enel, etc.), defina "VALIDO" como true.
    Se for apenas uma foto de pessoa ou paisagem, defina false.
    - Se a média de consumo for >= 150kWh, defina "ELEGIVEL" como true.
    
    Responda EXATAMENTE com este objeto JSON (sem formatação ou markdown em volta):
    {
      "VALIDO": true,
      "TARIFA_SOCIAL": false,
      "ELEGIVEL": true,
      "NOME_CLIENTE": "Nome completo",
      "CPF": "00000000000",
      "CNPJ": "00000000000000",
      "UC": "Numero da UC",
      "ENDERECO_NUMERO": "Numero da porta",
      "MEDIA_CONSUMO": 0
    }
  `;
  
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  let textoLimpo = res.data.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim();
  
  console.log(`[IA] Sucesso absoluto com gemini-2.5-pro!`);
  return JSON.parse(textoLimpo);
}

// 🧠 MOTOR IA DEFINITIVO E ATUALIZADO (Documento)
async function validarDocumentoIA(base64) {
  if (!GEMINI_API_KEY) throw new Error("Chave Gemini ausente!");
  
  // A URL E MODELO EXATOS QUE VOCÊ DESCOBRIU
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `
    A imagem anexa é uma foto válida de um RG (Identidade) ou CNH brasileiro (frente ou verso)? 
    Responda APENAS com este JSON (sem markdown):
    {"VALIDO": true}
  `;
  
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  let textoLimpo = res.data.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim();
  return JSON.parse(textoLimpo).VALIDO;
}
