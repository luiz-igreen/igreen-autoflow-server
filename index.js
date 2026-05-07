import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURAÇÕES GERAIS E CHAVES
// ==========================================
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || "3F14E2A7F66AC2180C0BBA4D31290A14";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "88F232A54C5DC27793994637";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "F177679f2434d425e9a3e58ddec1d4cf0S"; 

// A chave vem do Cofre Seguro do Render
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

const IGREEN_LOGIN_URL = "[https://escritorio.igreenenergy.com.br/login](https://escritorio.igreenenergy.com.br/login)"; 
const IGREEN_MAPA_URL = "[https://escritorio.igreenenergy.com.br/mapa-clientes](https://escritorio.igreenenergy.com.br/mapa-clientes)";

const IGREEN_USER = process.env.IGREEN_USER || "jorgeluizhouse@hotmail.com";
const IGREEN_PASS = process.env.IGREEN_PASS || "@@Lkjdsa12345";

const APP_ID = 'igreen-autoflow-v4';

try {
  const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
  if (firebaseConfig && admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    console.log("✅ Banco de Dados Cloud ligado!");
  }
} catch (e) { console.error("Erro DB:", e.message); }

const memoriaEstado = new Map();

const TEXTOS = {
    T_MENU: "👋 Olá! Bem-vindo ao *Atendimento Inteligente iGreen*. \n\nEscolha uma das opções abaixo enviando apenas o número:\n\n" +
            "1️⃣ *Novo Cadastro* (Ler fatura e preparar contrato)\n" +
            "2️⃣ *Guardar Fatura* (Apenas salvar no Banco de Dados)\n" +
            "3️⃣ *Resgatar Dados* (Puxar dados do portal iGreen)\n\n" +
            "_(Digite *0* a qualquer momento para cancelar e voltar a este menu)_",
    T01: "Opção 1️⃣ selecionada! 🌿 \nPara prepararmos o seu desconto e gerar o contrato, por favor, me envie uma foto bem nítida (ou PDF) da sua conta de luz mais recente.",
    T02: "Recebemos a sua fatura! 📄 A nossa Inteligência Artificial está a extrair os dados neste exato momento. Um momento...",
    T_RESGATE_START: "Opção 3️⃣ selecionada! ⚡ \n*Módulo de Extração* ativado! Digite apenas o *Nome ou ID* do cliente (Ex: Robson Carlos ou 1119032):",
    T_RESGATE_BUSCANDO: "🔍 O Robô Fantasma iniciou a varredura profunda no *Escritório Virtual iGreen*...",
    T_RESGATE_FAIL: "⚠️ O Robô varreu o código-fonte da iGreen, mas o cliente não possui CPF registado na tabela ou a busca falhou.",
    T_GUARDAR_START: "Opção 2️⃣ selecionada! 💾 \n*Módulo de Pré-Cadastro* ativado! Envie apenas a foto ou PDF da *Fatura de Energia*. Eu vou extrair os dados e guardar no banco sem acionar o Robô RPA."
};

const CHROME_ARGS = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", 
    "--disable-gpu", "--single-process", "--no-zygote", "--js-flags=--expose-gc"
];

// ==========================================
// FUNÇÕES AUXILIARES (Z-API & FIREBASE)
// ==========================================
async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try { 
        console.log(`[Z-API] Enviando mensagem para ${numLimpo}...`);
        await axios.post(
            `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
            { phone: numLimpo, message: String(message) }, 
            { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN, 'Content-Type': 'application/json' } }
        ); 
        console.log(`[Z-API] ✅ Mensagem enviada!`);
    } catch (e) {
        console.error(`[Z-API] ❌ Erro:`, e.message);
    }
}

async function salvarNoBanco(phone, dados) {
    if (admin.apps.length > 0) {
        try {
            const db = admin.firestore();
            await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(phone).set(
                { ...dados, TELEFONE: phone, DATA_PROCESSAMENTO: admin.firestore.FieldValue.serverTimestamp() }, 
                { merge: true }
            );
            console.log(`[FIREBASE] ✅ Dados salvos com sucesso para ${phone}`);
        } catch (e) { console.error("Erro ao salvar no banco:", e.message); }
    }
}

// ==========================================
// MÓDULO 1: MOTOR IA (V125 - GEMINI 3 FLASH PREVIEW + JSON SCHEMA)
// ==========================================
async function analisarFaturaGemini(mediaUrl, mimeType) {
    if (!GEMINI_API_KEY) {
        console.error("❌ ERRO FATAL: Chave GEMINI_API_KEY não foi encontrada no Render.");
        throw new Error("Chave do Gemini ausente no Cofre do Servidor.");
    }
    
    const chaveLimpa = String(GEMINI_API_KEY).trim();

    console.log(`[GEMINI] Baixando documento: ${mediaUrl}`);
    const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
    const base64Data = Buffer.from(response.data, 'binary').toString('base64');
    
    // Inovação - Usando System Instructions para blindar a IA
    const payload = {
        systemInstruction: {
            parts: [{ text: "Você é um auditor sênior de faturas de energia elétrica da iGreen Energy. Extraia os dados solicitados com precisão absoluta. Não adicione nenhum comentário ou texto fora do JSON." }]
        },
        contents: [{ 
            parts: [
                { text: "Extraia os dados desta fatura." }, 
                { inlineData: { mimeType: mimeType, data: base64Data } }
            ] 
        }],
        // Inovação - JSON Schema Rígido (Força a resposta perfeita)
        generationConfig: { 
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    "NOME_CLIENTE": { type: "STRING", description: "Nome completo do titular." },
                    "CPF": { type: "STRING", description: "Apenas números do CPF ou CNPJ." },
                    "DISTRIBUIDORA": { type: "STRING", description: "Nome da concessionária." },
                    "UC": { type: "STRING", description: "Número da Unidade Consumidora (apenas números)." },
                    "MEDIA_CONSUMO": { type: "STRING", description: "Cálculo da média aritmética em kWh." },
                    "CEP": { type: "STRING", description: "CEP do endereço (se visível)." }
                },
                required: ["NOME_CLIENTE", "CPF", "DISTRIBUIDORA", "UC", "MEDIA_CONSUMO", "CEP"]
            }
        }
    };

    // O Modelo de Produção Atualizado! Ativo e livre de erro 404.
    const endpointFinal = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${chaveLimpa}`;

    // Retentativas Inteligentes (Exponential Backoff)
    let tentativas = 3;
    let atraso = 1000;

    console.log(`[GEMINI] Conectando na API Oficial Estável com o modelo gemini-3-flash-preview...`);

    while (tentativas > 0) {
        try {
            const aiRes = await axios.post(endpointFinal, payload);
            console.log(`[GEMINI] ✅ Sucesso! Dados extraídos e estruturados.`);
            return JSON.parse(aiRes.data.candidates[0].content.parts[0].text);
            
        } catch (error) {
            tentativas--;
            if (tentativas === 0) {
                const erroGoogle = error.response?.data ? JSON.stringify(error.response.data, null, 2) : error.message;
                console.error("❌ [ERRO FATAL GEMINI V125]:\n", erroGoogle);
                throw new Error("A Inteligência Artificial da Google recusou o documento. Verifique os logs no Render.");
            }
            console.warn(`[GEMINI] A tentar novamente em ${atraso}ms...`);
            await new Promise(r => setTimeout(r, atraso));
            atraso *= 2; 
        }
    }
}

// ==========================================
// MÓDULO 2: EXTRATOR RPA (PUPPETEER)
// ==========================================
async function fluxoExtracaoDados(termoBusca, phone) {
    let browser;
    try {
        console.log(`[EXTRATOR] ⚠️ Iniciando Navegador Fantasma RPA...`);
        browser = await puppeteer.launch({ headless: "new", args: CHROME_ARGS });
        const page = await browser.newPage();
        await page.setViewport({ width: 2560, height: 1440 });
        
        await page.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        const emailSel = 'input[type="email"], input[placeholder*="e-mail" i], input[name*="email" i]';
        const passSel = 'input[type="password"], input[placeholder*="senha" i], input[name*="pass" i]';
        await page.waitForSelector(emailSel, { timeout: 15000 });
        
        await page.click(emailSel, { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type(emailSel, IGREEN_USER, { delay: 50 });
        await page.click(passSel, { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type(passSel, IGREEN_PASS, { delay: 50 });
        
        const btnLoginEncontrado = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const btn = btns.find(b => b.innerText.toLowerCase().includes('entrar') || b.innerText.toLowerCase().includes('acessar'));
            if (btn) { btn.id = "btn_login_igreen_injetor"; return true; }
            return false;
        });

        if (btnLoginEncontrado) await page.click('#btn_login_igreen_injetor'); else await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 6000));

        await page.goto(IGREEN_MAPA_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 8000)); 

        const searchSelector = 'input[placeholder*="Pesquisar" i], input[placeholder*="Buscar" i]';
        const searchInput = await page.waitForSelector(searchSelector, { timeout: 15000 });
        await searchInput.click({ clickCount: 3 }); await page.keyboard.press('Backspace'); 
        await page.type(searchSelector, termoBusca, { delay: 100 }); await page.keyboard.press('Enter');
        
        let dadosExtraidos = null;
        for (let tentativa = 1; tentativa <= 6; tentativa++) {
            dadosExtraidos = await page.evaluate((busca) => {
                const areaBusca = document.querySelector('tbody') || document.querySelector('table') || document.body;
                const textoGigante = areaBusca.textContent || "";
                if (textoGigante.includes('Nenhum registro') || textoGigante.trim() === '') return { cpf: "Não encontrado" };

                let nomeFinal = "Cliente Localizado", cpfFinal = "Não encontrado", nascFinal = "Não consta na tabela";
                const linhas = Array.from(areaBusca.querySelectorAll('tr, [role="row"]'));
                const linhaCorreta = linhas.find(tr => tr.textContent.toLowerCase().includes(busca.toLowerCase()));
                
                if (linhaCorreta) {
                    const textoLinha = linhaCorreta.textContent;
                    const padraoCpf = textoLinha.match(/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
                    if (padraoCpf) cpfFinal = padraoCpf[0];

                    const padraoDatas = textoLinha.match(/\d{2}\/\d{2}\/\d{4}/g);
                    if (padraoDatas) {
                        const datasAntigas = padraoDatas.filter(d => parseInt(d.split('/')[2]) < 2010);
                        if (datasAntigas.length > 0) nascFinal = datasAntigas[0];
                    }

                    const celulas = Array.from(linhaCorreta.querySelectorAll('td, th, [role="cell"]'));
                    if (celulas.length > 1 && /[a-zA-Z]/.test(celulas[1].textContent) && celulas[1].textContent.trim().length > 3) {
                        nomeFinal = celulas[1].textContent.trim();
                    }
                }
                return { nome: nomeFinal, cpf: cpfFinal, nasc: nascFinal };
            }, termoBusca);

            if (dadosExtraidos && dadosExtraidos.cpf !== "Não encontrado") break;
            await new Promise(r => setTimeout(r, 2000));
        }

        await browser.close();

        if (!dadosExtraidos || dadosExtraidos.cpf === "Não encontrado") {
            await enviarMensagem(phone, TEXTOS.T_RESGATE_FAIL);
            return;
        }

        const msgFinal = `✅ *DADOS CAPTURADOS COM SUCESSO!* 🕵️‍♂️\n\n👤 *Nome:* ${dadosExtraidos.nome}\n📄 *Documento:* ${dadosExtraidos.cpf}\n🎂 *Nascimento:* ${dadosExtraidos.nasc}\n\n⚡ *Atalhos (2ª Via Rápida):*\n➡️ *Equatorial AL:* https://al.equatorialenergia.com.br/siteantigo\n➡️ *Cemig MG:* https://wa.me/553135061160?text=Segunda+via`;
        await enviarMensagem(phone, msgFinal);

    } catch (error) {
        if(browser) await browser.close();
        await enviarMensagem(phone, `⚠️ O servidor teve um soluço técnico: ${error.message}`);
    }
}

// ==========================================
// LÓGICA DO WEBHOOK CENTRAL
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

    console.log(`[WEBHOOK] Msg de ${phone} | Tem Mídia? ${temMidia ? 'SIM' : 'NÃO'} | Texto: ${txtL}`);

    if (txtL === '0' || txtL === 'cancelar' || txtL === 'menu') {
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'NOVO' });
        await enviarMensagem(phone, "🔄 Operação cancelada com sucesso.\n\n" + TEXTOS.T_MENU);
        return;
    }

    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };

    if (mem.STATUS_CADASTRO === 'NOVO') {
        if (txtL === '1' || ['novo', 'nova'].includes(txtL)) {
            memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA' });
            await enviarMensagem(phone, TEXTOS.T01); 
            return;
        }

        if (txtL === '2' || ['guardar', 'atualizar', 'salvar'].includes(txtL)) {
            memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA_SOH_BANCO' });
            await enviarMensagem(phone, TEXTOS.T_GUARDAR_START); 
            return;
        }

        if (txtL === '3' || ['resgatar', 'dados', 'puxar'].includes(txtL)) {
            memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_TERMO_RESGATE' });
            await enviarMensagem(phone, TEXTOS.T_RESGATE_START); 
            return;
        }

        await enviarMensagem(phone, TEXTOS.T_MENU);
        return;
    }

    switch (mem.STATUS_CADASTRO) {
        
        case 'AGUARDANDO_FATURA':
            if (temMidia) {
                await enviarMensagem(phone, TEXTOS.T02); 
                
                try {
                    const dadosIA = await analisarFaturaGemini(mediaUrl, mimeType);
                    
                    await salvarNoBanco(phone, {
                        NOME_CLIENTE: dadosIA.NOME_CLIENTE || "Cliente",
                        CPF: dadosIA.CPF || "Não extraído",
                        UC: dadosIA.UC || "Não extraído",
                        MEDIA_CONSUMO: dadosIA.MEDIA_CONSUMO || "0",
                        DISTRIBUIDORA: dadosIA.DISTRIBUIDORA || "Equatorial",
                        CEP: dadosIA.CEP || "",
                        LINK_FATURA: mediaUrl,
                        STATUS_CADASTRO: "CONCLUIDO" 
                    });

                    await enviarMensagem(phone, `✅ Fatura aprovada!\n👤 Titular: ${dadosIA.NOME_CLIENTE}\n⚡ Média: ${dadosIA.MEDIA_CONSUMO} kWh.\n\nTodos os dados foram enviados para a Central de Injeção. O consultor gerará o seu contrato em breve!`);
                    memoriaEstado.delete(phone); 
                } catch (error) {
                    console.error("❌ [ERRO AO SALVAR]:", error.message);
                    await enviarMensagem(phone, "❌ A Inteligência Artificial teve dificuldade em ler este documento ou a Google bloqueou o acesso temporariamente. Verifique a tela do Render.");
                }
            } else {
                await enviarMensagem(phone, "⚠️ Por favor, envie a foto ou o PDF da fatura para prosseguirmos. Ou digite *0* para voltar ao menu.");
            }
            break;

        case 'AGUARDANDO_FATURA_SOH_BANCO':
            if (temMidia) {
                await enviarMensagem(phone, TEXTOS.T02); 
                
                try {
                    const dadosIA = await analisarFaturaGemini(mediaUrl, mimeType);
                    
                    await salvarNoBanco(phone, {
                        NOME_CLIENTE: dadosIA.NOME_CLIENTE || "Cliente",
                        CPF: dadosIA.CPF || "Não extraído",
                        UC: dadosIA.UC || "Não extraído",
                        MEDIA_CONSUMO: dadosIA.MEDIA_CONSUMO || "0",
                        DISTRIBUIDORA: dadosIA.DISTRIBUIDORA || "Equatorial",
                        CEP: dadosIA.CEP || "",
                        LINK_FATURA: mediaUrl,
                        STATUS_CADASTRO: "PENDENTE_DOCUMENTOS" 
                    });

                    await enviarMensagem(phone, `✅ Fatura lida e guardada no seu Banco de Dados!\n👤 Titular: ${dadosIA.NOME_CLIENTE}\n⚡ Média: ${dadosIA.MEDIA_CONSUMO} kWh.\n\n⚠️ Status: *Pendente de Documentos*. O Robô de injeção automática NÃO foi acionado. Quando o cliente tiver o RG/CNH em mãos, avise-me!`);
                    memoriaEstado.delete(phone); 
                } catch (error) {
                    console.error("❌ [ERRO AO SALVAR]:", error.message);
                    await enviarMensagem(phone, "❌ A Inteligência Artificial teve dificuldade em ler este documento ou a Google bloqueou o acesso temporariamente. Verifique a tela do Render.");
                }
            } else {
                await enviarMensagem(phone, "⚠️ Aguardando a sua Fatura. Envie a imagem/PDF ou digite *0* para cancelar.");
            }
            break;

        case 'AGUARDANDO_TERMO_RESGATE':
            if (textoIn.length >= 2) {
                await enviarMensagem(phone, TEXTOS.T_RESGATE_BUSCANDO);
                memoriaEstado.delete(phone); 
                setTimeout(() => { fluxoExtracaoDados(textoIn, phone); }, 3000);
            } else {
                await enviarMensagem(phone, "⚠️ Digite o Nome ou ID para buscar. Ou digite *0* para voltar ao menu.");
            }
            break;
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 SERVIDOR V125 ONLINE (Sintaxe Corrigida + JSON Schema)`));
