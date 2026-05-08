import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURAÇÕES GERAIS E CHAVES (Cofre Seguro do Render)
// ==========================================
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN; 

const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

const IGREEN_LOGIN_URL = "https://escritorio.igreenenergy.com.br/login"; 
const IGREEN_MAPA_URL = "https://escritorio.igreenenergy.com.br/mapa-clientes";

const IGREEN_USER = process.env.IGREEN_USER;
const IGREEN_PASS = process.env.IGREEN_PASS;

const APP_ID = 'igreen-autoflow-v4';

try {
    const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
    if (firebaseConfig && admin.apps.length === 0) {
        admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
        console.log("✅ Banco de Dados Cloud ligado!");
    }
} catch (e) { console.error("Erro DB:", e.message); }

const memoriaEstado = new Map();

// ==========================================
// TEXTOS HUMANIZADOS DO ATENDIMENTO
// ==========================================
const TEXTOS = {
    T_MENU: "👋 Olá! Bem-vindo ao *Atendimento Inteligente iGreen*. \n\nComo posso ajudar hoje? Escolha uma das opções abaixo enviando apenas o número:\n\n" +
            "1️⃣ *Novo Cadastro* (Analisar fatura e preparar o seu desconto)\n" +
            "2️⃣ *Pré-Cadastro* (Salvar dados da fatura)\n" +
            "3️⃣ *Consultar Informações* (Buscar dados no sistema)\n" +
            "4️⃣ *Enviar Documentos* (Anexar RG ou CNH pendentes)\n\n" +
            "_(Dica: Digite *0* a qualquer momento para voltar a este menu)_",
    T01: "Opção 1️⃣ selecionada! 🌿 \nPara prepararmos o seu desconto e o seu contrato, por favor, envie uma foto bem nítida (ou arquivo PDF) da sua conta de luz mais recente.",
    T02: "Recebemos o seu documento! 📄 A nossa assistente virtual está a analisar as informações neste exato momento. Só um instante...",
    T_RESGATE_START: "Opção 3️⃣ selecionada! ⚡ \nPara buscar as informações do cliente, digite apenas o *Nome completo ou ID* de cadastro (Ex: Robson Carlos ou 1119032):",
    T_RESGATE_BUSCANDO: "🔍 Aguarde um momento. Estou buscando as informações de forma segura no sistema...",
    T_RESGATE_FAIL: "⚠️ Não consegui localizar este cliente no sistema. Por favor, verifique se o Nome ou ID estão digitados corretamente.",
    T_GUARDAR_START: "Opção 2️⃣ selecionada! 💾 \n*Módulo de Pré-Cadastro* ativado!\nPor favor, envie a foto ou PDF da sua *Fatura de Energia*. Vou analisar os dados e deixá-los salvos com total segurança no nosso sistema.",
    
    // NOVOS TEXTOS DE COLETA DE DADOS (OPÇÃO 2)
    T_PEDIR_TELEFONE: "✅ Fatura analisada e salva com segurança!\n👤 Titular: ${nome}\n⚡ UC: ${uc}\n\nPara completarmos o seu pré-cadastro, por favor, digite o **Número de Telefone (com DDD)** do titular:",
    T_PEDIR_EMAIL: "Ótimo! 📱 Telefone salvo.\n\nAgora, por favor, digite o **melhor E-mail** do titular:",
    T_FIM_PRE_CADASTRO: "Perfeito! 📧 E-mail salvo no seu perfil.\n\n⚠️ *Aviso Importante:* O seu cadastro está 'Pendente de Documentos'. Como você já é cliente iGreen, não há pressa! Quando quiser atualizar nosso sistema com a foto do seu documento (Frente e Verso), basta voltar a este atendimento e escolher a **Opção 4**.",
    
    T_START_OPCAO_4: "Opção 4️⃣ selecionada! 📎\nPara anexarmos o documento no imóvel correto, por favor, digite primeiro o número da sua **UC (Unidade Consumidora) ou Conta Contrato** (apenas os números):",
    T_PEDIR_FOTO_DOC_FRENTE: "🔍 Imóvel localizado! \n\nPara seguirmos o padrão da distribuidora, por favor, envie agora uma foto legível apenas da **FRENTE** do seu Documento de Identificação (RG ou CNH):",
    T_PEDIR_FOTO_DOC_VERSO: "✅ Frente recebida e salva!\n\nAgora, para concluirmos, por favor envie a foto do **VERSO** do mesmo documento:",
    T_DOCS_RECEBIDOS: "✅ Documentos recebidos com sucesso! \nAs imagens (Frente e Verso) foram anexadas ao seu perfil com segurança. O seu cadastro está completo! Muito obrigado pela sua colaboração! 🙏"
};

const CHROME_ARGS = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", 
    "--disable-gpu", "--single-process", "--no-zygote", "--js-flags=--expose-gc"
];

// ==========================================
// FUNÇÕES AUXILIARES
// ==========================================
async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try { 
        await axios.post(
            `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
            { phone: numLimpo, message: String(message) }, 
            { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN, 'Content-Type': 'application/json' } }
        ); 
    } catch (e) { console.error(`[Z-API] Erro:`, e.message); }
}

function limparDadosVazios(dados) {
    return Object.fromEntries(
        Object.entries(dados).filter(([_, v]) => v !== "" && v !== "Não extraído" && v !== "0" && v !== null && v !== undefined)
    );
}

async function salvarNoBanco(docId, phone, dadosExtras) {
    if (admin.apps.length > 0) {
        try {
            const db = admin.firestore();
            const dadosLimpos = limparDadosVazios(dadosExtras); 
            await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(docId).set(
                { 
                    ...dadosLimpos, 
                    TELEFONE_REMETENTE: phone, 
                    DATA_PROCESSAMENTO: admin.firestore.FieldValue.serverTimestamp(),
                    DATA_ULTIMA_ATUALIZACAO: admin.firestore.FieldValue.serverTimestamp()
                }, 
                { merge: true } 
            );
            console.log(`[FIREBASE] ✅ Dados salvos na UC: ${docId}`);
        } catch (e) { console.error("Erro Firebase:", e.message); }
    }
}

// ==========================================
// MÓDULO 1: MOTOR IA
// ==========================================
async function analisarFaturaGemini(mediaUrl, mimeType) {
    if (!GEMINI_API_KEY) throw new Error("Chave do Gemini ausente.");
    
    const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
    const base64Data = Buffer.from(response.data, 'binary').toString('base64');
    
    const instrucaoSistema = `Você é um auditor sênior de faturas de energia iGreen. Extraia os dados com precisão absoluta seguindo a ordem lógica da fatura.
REGRA DE CÁLCULO DA MEDIA_CONSUMO: Localize o histórico em kWh. Some os últimos 6 meses (de baixo para cima) e divida por 6. Se tiver menos meses, divida pelo número de meses disponíveis.
Se um dado não estiver visível, deixe vazio.`;

    const payload = {
        systemInstruction: {
            parts: [{ text: instrucaoSistema }]
        },
        contents: [{ 
            parts: [
                { text: "Analise esta fatura e extraia os dados organizadamente." }, 
                { inlineData: { mimeType: mimeType, data: base64Data } }
            ] 
        }],
        generationConfig: { 
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    "DISTRIBUIDORA": { type: "STRING" },
                    "NOME_CLIENTE": { type: "STRING" },
                    "MASCARA_CPF": { type: "STRING" },
                    "CPF": { type: "STRING" },
                    "ENDERECO": { type: "STRING" },
                    "ENDERECO_NUMERO": { type: "STRING" },
                    "ENDERECO_COMPLEMENTO": { type: "STRING" },
                    "BAIRRO": { type: "STRING" },
                    "CIDADE": { type: "STRING" },
                    "ESTADO": { type: "STRING" },
                    "CEP": { type: "STRING" },
                    "UC": { type: "STRING" },
                    "CONTA_MES": { type: "STRING" },
                    "VENCIMENTO": { type: "STRING" },
                    "VALOR_FATURA": { type: "STRING" },
                    "MEDIA_CONSUMO": { type: "STRING" }
                },
                required: ["DISTRIBUIDORA", "NOME_CLIENTE", "MASCARA_CPF", "CPF", "ENDERECO", "ENDERECO_NUMERO", "ENDERECO_COMPLEMENTO", "BAIRRO", "CIDADE", "ESTADO", "CEP", "UC", "CONTA_MES", "VENCIMENTO", "VALOR_FATURA", "MEDIA_CONSUMO"]
            }
        }
    };

    const endpointFinal = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY.trim()}`;

    try {
        const aiRes = await axios.post(endpointFinal, payload);
        return JSON.parse(aiRes.data.candidates[0].content.parts[0].text);
    } catch (error) {
        console.error("❌ Erro Gemini:", error.message);
        throw error;
    }
}

// ==========================================
// MÓDULO 2: EXTRATOR RPA
// ==========================================
async function fluxoExtracaoDados(termoBusca, phone) {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: CHROME_ARGS });
        const page = await browser.newPage();
        await page.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('input[type="email"]');
        await page.type('input[type="email"]', IGREEN_USER);
        await page.type('input[type="password"]', IGREEN_PASS);
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 6000));
        await page.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 8000)); 
        const searchInput = await page.waitForSelector('input[placeholder*="Pesquisar" i]');
        await searchInput.type(termoBusca); await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 4000));
        const dadosExtraidos = await page.evaluate((busca) => {
            const linha = Array.from(document.querySelectorAll('tr')).find(tr => tr.textContent.toLowerCase().includes(busca.toLowerCase()));
            if (!linha) return null;
            const cpfMatch = linha.textContent.match(/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
            const dataMatch = linha.textContent.match(/\d{2}\/\d{2}\/\d{4}/g);
            return { nome: "Cliente Encontrado", cpf: cpfMatch ? cpfMatch[0] : "Não consta", nasc: dataMatch ? dataMatch[0] : "Não consta" };
        }, termoBusca);
        await browser.close();
        if (dadosExtraidos) await enviarMensagem(phone, `✅ *DADOS CAPTURADOS!* \n👤 *Nome:* ${dadosExtraidos.nome}\n📄 *CPF:* ${dadosExtraidos.cpf}\n🎂 *Nascimento:* ${dadosExtraidos.nasc}`);
    } catch (e) { if(browser) await browser.close(); }
}

// ==========================================
// LÓGICA DO WEBHOOK
// ==========================================
app.post('/webhook/igreen', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    if (data.fromMe) return;

    const phone = data.phone;
    const textoIn = data.text?.message?.trim() || "";
    const txtL = textoIn.toLowerCase();
    
    const temMidia = !!(data.image?.imageUrl || data.document?.documentUrl);
    const mediaUrl = data.image?.imageUrl || data.document?.documentUrl;
    const mimeType = data.document ? 'application/pdf' : 'image/jpeg';

    if (['0', 'cancelar', 'menu'].includes(txtL)) {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'NOVO' });
        await enviarMensagem(phone, "🔄 Operação cancelada.\n\n" + TEXTOS.T_MENU);
        return;
    }

    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };

    if (mem.STATUS_CADASTRO === 'NOVO') {
        if (txtL === '1') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA' }); await enviarMensagem(phone, TEXTOS.T01); return; }
        if (txtL === '2') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA_SOH_BANCO' }); await enviarMensagem(phone, TEXTOS.T_GUARDAR_START); return; }
        if (txtL === '3') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_TERMO_RESGATE' }); await enviarMensagem(phone, TEXTOS.T_RESGATE_START); return; }
        if (txtL === '4') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_UC_DOC' }); await enviarMensagem(phone, TEXTOS.T_START_OPCAO_4); return; }
        await enviarMensagem(phone, TEXTOS.T_MENU);
        return;
    }

    switch (mem.STATUS_CADASTRO) {
        case 'AGUARDANDO_FATURA':
            if (temMidia) {
                await enviarMensagem(phone, TEXTOS.T02); 
                try {
                    const dadosIA = await analisarFaturaGemini(mediaUrl, mimeType);
                    const docId = (dadosIA.UC && dadosIA.UC !== "Não extraído" && dadosIA.UC !== "") ? dadosIA.UC.replace(/\D/g, '') : `SEM_UC_${Date.now()}`;
                    
                    await salvarNoBanco(docId, phone, { ...dadosIA, LINK_FATURA: mediaUrl, STATUS_CADASTRO: "CONCLUIDO" });
                    await enviarMensagem(phone, `✅ Tudo certo!\n👤 Titular: ${dadosIA.NOME_CLIENTE}\n⚡ UC/Contrato: ${dadosIA.UC}\n💰 Valor: R$ ${dadosIA.VALOR_FATURA}\n📊 Média: ${dadosIA.MEDIA_CONSUMO} kWh\n\nDados validados com sucesso!`);
                    memoriaEstado.delete(phone); 
                } catch (e) { await enviarMensagem(phone, "❌ Erro ao ler fatura. Tente novamente."); }
            }
            break;

        case 'AGUARDANDO_FATURA_SOH_BANCO':
            if (temMidia) {
                await enviarMensagem(phone, TEXTOS.T02); 
                try {
                    const dadosIA = await analisarFaturaGemini(mediaUrl, mimeType);
                    const docId = (dadosIA.UC && dadosIA.UC !== "Não extraído" && dadosIA.UC !== "") ? dadosIA.UC.replace(/\D/g, '') : `SEM_UC_${Date.now()}`;
                    
                    await salvarNoBanco(docId, phone, { ...dadosIA, LINK_FATURA: mediaUrl, STATUS_CADASTRO: "AGUARDANDO_TELEFONE" });
                    
                    // Vai para o próximo passo: Pedir Telefone
                    memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_TELEFONE', docId: docId });
                    
                    const msgTel = TEXTOS.T_PEDIR_TELEFONE.replace('${nome}', dadosIA.NOME_CLIENTE).replace('${uc}', dadosIA.UC);
                    await enviarMensagem(phone, msgTel);
                } catch (e) { await enviarMensagem(phone, "❌ Erro na análise. Tente novamente."); }
            }
            break;

        case 'AGUARDANDO_TELEFONE':
            if (textoIn.length >= 8) { 
                const docId = mem.docId; 
                await salvarNoBanco(docId, phone, { TELEFONE: textoIn, STATUS_CADASTRO: "AGUARDANDO_EMAIL" });
                
                // Vai para o próximo passo: Pedir Email
                memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_EMAIL', docId: docId });
                await enviarMensagem(phone, TEXTOS.T_PEDIR_EMAIL);
            } else { await enviarMensagem(phone, "⚠️ Digite um telefone válido ou digite *0* para cancelar."); }
            break;

        case 'AGUARDANDO_EMAIL':
            if (textoIn.includes('@')) { 
                const docId = mem.docId; 
                await salvarNoBanco(docId, phone, { EMAIL: textoIn, STATUS_CADASTRO: "PENDENTE_DOCUMENTOS" });
                await enviarMensagem(phone, TEXTOS.T_FIM_PRE_CADASTRO);
                memoriaEstado.delete(phone); // Fim do fluxo de Pré-Cadastro!
            } else { await enviarMensagem(phone, "⚠️ Digite um E-mail válido contendo '@' ou digite *0* para cancelar."); }
            break;

        case 'AGUARDANDO_TERMO_RESGATE':
            if (textoIn.length >= 2) {
                await enviarMensagem(phone, TEXTOS.T_RESGATE_BUSCANDO);
                memoriaEstado.delete(phone); 
                setTimeout(() => { fluxoExtracaoDados(textoIn, phone); }, 3000);
            }
            break;

        case 'AGUARDANDO_UC_DOC':
            if (textoIn.length >= 4) { 
                const ucLimpa = textoIn.replace(/\D/g, '');
                memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE', docId: ucLimpa });
                await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_FRENTE);
            } else { await enviarMensagem(phone, "⚠️ Digite o número da UC ou digite *0*."); }
            break;

        case 'AGUARDANDO_DOC_FRENTE': 
            if (temMidia) {
                const docId = mem.docId; 
                await salvarNoBanco(docId, phone, { LINK_DOC_FRENTE: mediaUrl });
                memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_VERSO', docId: docId });
                await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_VERSO);
            } else { await enviarMensagem(phone, "⚠️ Envie a imagem da FRENTE do documento."); }
            break;

        case 'AGUARDANDO_DOC_VERSO': 
            if (temMidia) {
                const docId = mem.docId; 
                await salvarNoBanco(docId, phone, { LINK_DOC_VERSO: mediaUrl, STATUS_CADASTRO: "CONCLUIDO_COM_DOCS" });
                await enviarMensagem(phone, TEXTOS.T_DOCS_RECEBIDOS);
                memoriaEstado.delete(phone);
            } else { await enviarMensagem(phone, "⚠️ Envie a imagem do VERSO do documento."); }
            break;
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
