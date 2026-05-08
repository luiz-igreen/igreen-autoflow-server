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
    T_PEDIR_NASCIMENTO: "✅ Fatura analisada e salva com segurança!\n👤 Titular: ${nome}\n⚡ Unidade Consumidora: ${uc}\n\nPara facilitar emissões de *Segunda Via* no futuro, por favor, digite a sua **Data de Nascimento** (Ex: 15/08/1985):",
    T_FIM_PRE_CADASTRO: "Obrigado! 📅 Data de nascimento salva no seu perfil.\n\n⚠️ *Aviso Importante:* O seu cadastro está 'Pendente de Documentos'. Como você já é cliente iGreen, não há pressa! Quando quiser atualizar nosso sistema com a foto do seu documento (RG ou CNH), basta voltar a este atendimento e escolher a **Opção 4**.",
    T_START_OPCAO_4: "Opção 4️⃣ selecionada! 📎\nPara anexarmos o documento no imóvel correto, por favor, digite primeiro o número da sua **UC (Unidade Consumidora) ou Conta Contrato** (apenas os números):",
    T_PEDIR_FOTO_DOC: "🔍 Imóvel localizado e pronto para atualização! \n\nAgora, por favor, envie a **foto legível do seu Documento de Identificação (RG ou CNH)**:",
    T_DOCS_RECEBIDOS: "✅ Documento recebido com sucesso! \nO arquivo foi anexado ao seu perfil com segurança para futuras necessidades. Muito obrigado pela sua colaboração! 🙏"
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
                    DATA_PROCESSAMENTO: admin.firestore.FieldValue.serverTimestamp(), // Corrigido para o Dashboard!
                    DATA_ULTIMA_ATUALIZACAO: admin.firestore.FieldValue.serverTimestamp()
                }, 
                { merge: true } 
            );
            console.log(`[FIREBASE] ✅ Dados salvos na UC: ${docId}`);
        } catch (e) { console.error("Erro Firebase:", e.message); }
    }
}

// ==========================================
// MÓDULO 1: MOTOR IA (OCR AVANÇADO)
// ==========================================
async function analisarFaturaGemini(mediaUrl, mimeType) {
    if (!GEMINI_API_KEY) throw new Error("Chave do Gemini ausente.");
    
    const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
    const base64Data = Buffer.from(response.data, 'binary').toString('base64');
    
    const instrucaoSistema = `Você é um auditor sênior de faturas de energia iGreen. Extraia os dados com precisão absoluta. 
REGRA DE CÁLCULO DA MEDIA_CONSUMO: Localize o histórico de consumo em kWh na fatura. Contando de baixo para cima (do mais recente para o mais antigo), pegue os últimos 6 meses registrados. Some o consumo (kWh) desses 6 meses e divida por 6. Se o cliente for novo e o histórico tiver menos de 6 meses (ex: apenas 3 meses), some os consumos disponíveis e divida pela exata quantidade de meses disponíveis. Retorne o valor numérico em kWh.
Se um dado não estiver visível ou estiver oculto por LGPD, coloque o que estiver escrito ou deixe vazio.`;

    const payload = {
        systemInstruction: {
            parts: [{ text: instrucaoSistema }]
        },
        contents: [{ 
            parts: [
                { text: "Analise esta fatura e extraia todos os dados solicitados no JSON Schema, quebrando o endereço em partes." }, 
                { inlineData: { mimeType: mimeType, data: base64Data } }
            ] 
        }],
        generationConfig: { 
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    "NOME_CLIENTE": { type: "STRING" },
                    "MASCARA_CPF": { type: "STRING", description: "O CPF exatamente como impresso na fatura, com os asteriscos da LGPD (Ex: ***.123.456-**)" },
                    "CPF": { type: "STRING", description: "Apenas os números visíveis do CPF. Se estiver totalmente legível, coloque completo." },
                    "DISTRIBUIDORA": { type: "STRING" },
                    "UC": { type: "STRING", description: "Número da Unidade Consumidora ou Conta Contrato (apenas números)." },
                    "MEDIA_CONSUMO": { type: "STRING", description: "Média proporcional dos últimos 6 meses em kWh." },
                    "CONTA_MES": { type: "STRING", description: "Mês e ano de referência (Ex: 04/2026)" },
                    "VENCIMENTO": { type: "STRING", description: "Data de vencimento da fatura" },
                    "CEP": { type: "STRING" },
                    "ENDERECO": { type: "STRING", description: "Nome da Rua/Avenida/Logradouro" },
                    "ENDERECO_NUMERO": { type: "STRING", description: "Número do imóvel" },
                    "COMPLEMENTO": { type: "STRING", description: "Complemento (Bloco, Apto, Casa, Quadra, etc)" },
                    "BAIRRO": { type: "STRING", description: "Bairro" },
                    "CIDADE": { type: "STRING", description: "Cidade" },
                    "ESTADO": { type: "STRING", description: "Sigla do Estado/UF (Ex: AL, MG, SP)" }
                },
                required: ["NOME_CLIENTE", "MASCARA_CPF", "CPF", "DISTRIBUIDORA", "UC", "MEDIA_CONSUMO", "CEP", "CONTA_MES", "VENCIMENTO", "ENDERECO", "ENDERECO_NUMERO", "COMPLEMENTO", "BAIRRO", "CIDADE", "ESTADO"]
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
// MÓDULO 2: EXTRATOR RPA (PUPPETEER)
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

        if (dadosExtraidos) {
            await enviarMensagem(phone, `✅ *DADOS CAPTURADOS!* \n👤 *Nome:* ${dadosExtraidos.nome}\n📄 *CPF:* ${dadosExtraidos.cpf}\n🎂 *Nascimento:* ${dadosExtraidos.nasc}`);
        } else {
            await enviarMensagem(phone, TEXTOS.T_RESGATE_FAIL);
        }
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
                    await enviarMensagem(phone, `✅ Tudo certo!\n👤 Titular: ${dadosIA.NOME_CLIENTE}\n⚡ UC/Contrato: ${dadosIA.UC}\n📍 Bairro/Cidade: ${dadosIA.BAIRRO}, ${dadosIA.CIDADE}\n📊 Média Calculada: ${dadosIA.MEDIA_CONSUMO} kWh\n\nOs seus dados foram validados e o especialista gerará o contrato em breve!`);
                    memoriaEstado.delete(phone); 
                } catch (e) { await enviarMensagem(phone, "❌ Erro ao ler fatura. Tente enviar uma foto mais nítida."); }
            }
            break;

        case 'AGUARDANDO_FATURA_SOH_BANCO':
            if (temMidia) {
                await enviarMensagem(phone, TEXTOS.T02); 
                try {
                    const dadosIA = await analisarFaturaGemini(mediaUrl, mimeType);
                    const docId = (dadosIA.UC && dadosIA.UC !== "Não extraído" && dadosIA.UC !== "") ? dadosIA.UC.replace(/\D/g, '') : `SEM_UC_${Date.now()}`;
                    
                    await salvarNoBanco(docId, phone, { ...dadosIA, LINK_FATURA: mediaUrl, STATUS_CADASTRO: "AGUARDANDO_NASCIMENTO" });
                    memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_NASCIMENTO', docId: docId });
                    
                    const msgNasc = TEXTOS.T_PEDIR_NASCIMENTO.replace('${nome}', dadosIA.NOME_CLIENTE).replace('${uc}', dadosIA.UC);
                    await enviarMensagem(phone, msgNasc);
                } catch (e) { await enviarMensagem(phone, "❌ Erro na análise. Tente enviar uma foto mais nítida."); }
            }
            break;

        case 'AGUARDANDO_NASCIMENTO':
            if (textoIn.length >= 8) { 
                const docId = mem.docId; 
                await salvarNoBanco(docId, phone, { DATA_NASCIMENTO: textoIn, STATUS_CADASTRO: "PENDENTE_DOCUMENTOS" });
                await enviarMensagem(phone, TEXTOS.T_FIM_PRE_CADASTRO);
                memoriaEstado.delete(phone); 
            } else { await enviarMensagem(phone, "⚠️ Digite uma data válida."); }
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
                memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOCUMENTOS_AVULSOS', docId: ucLimpa });
                await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC);
            } else {
                await enviarMensagem(phone, "⚠️ Por favor, digite os números da sua UC ou Conta Contrato, ou digite *0* para cancelar.");
            }
            break;

        case 'AGUARDANDO_DOCUMENTOS_AVULSOS': 
            if (temMidia) {
                const docId = mem.docId; 
                await salvarNoBanco(docId, phone, { LINK_DOCUMENTO_ID: mediaUrl, STATUS_CADASTRO: "CONCLUIDO_COM_DOCS" });
                await enviarMensagem(phone, TEXTOS.T_DOCS_RECEBIDOS);
                memoriaEstado.delete(phone);
            } else {
                await enviarMensagem(phone, "⚠️ Por favor, envie a foto do documento ou digite *0* para cancelar.");
            }
            break;
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
