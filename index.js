import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURAÇÕES GERAIS E CHAVES
// ==========================================
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN; 

const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

const IGREEN_LOGIN_URL = "https://escritorio.igreenenergy.com.br"; 
const EQUATORIAL_AL_URL = "https://al.equatorialenergia.com.br/siteantigo";

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
// TEXTOS NACIONALIZADOS
// ==========================================
const TEXTOS = {
    T_MENU: "👋 Olá! Bem-vindo ao *Atendimento Inteligente iGreen*. \n\nComo posso ajudar hoje? Escolha uma das opções abaixo enviando apenas o número:\n\n" +
            "1️⃣ *Novo Cadastro* (Analisar fatura e preparar o seu desconto)\n" +
            "2️⃣ *Pré-Cadastro* (Salvar dados da fatura)\n" +
            "3️⃣ *Resolver Devolutiva* (Buscar fatura atualizada na distribuidora local e reenviar para a iGreen)\n" +
            "4️⃣ *Enviar Documentos* (Anexar RG ou CNH pendentes)\n\n" +
            "_(Dica: Digite *0* a qualquer momento para voltar a este menu)_",
            
    T01: "Opção 1️⃣ selecionada! 🌿 \nPara prepararmos o seu desconto e o seu contrato, por favor, envie uma foto bem nítida (ou arquivo PDF) da sua conta de luz mais recente.",
    T02: "Recebemos o seu documento! 📄 A nossa assistente virtual está a analisar as informações neste exato momento. Só um instante...",
    
    T_RESGATE_START: "Opção 3️⃣ selecionada! ⚡ \nPara buscarmos a sua fatura atualizada na sua *Distribuidora Local* e resolvermos a pendência de consumo, por favor, digite o seu **CPF**, sua **Data de Nascimento** e o número da **UC**, separados por um espaço.\n\n*(Ex: 12345678900 15/08/1985 987654)*:",
    T_RESGATE_BUSCANDO: "🔍 Iniciando o robô de integração...\n\n1️⃣ Acessando a Distribuidora Local...\n2️⃣ Localizando a UC exata e baixando fatura...\n3️⃣ Injetando no painel de Devolutivas da iGreen...\n\nIsso pode levar alguns segundos, por favor aguarde...",
    T_RESGATE_SUCESSO: "✅ Sucesso! A fatura atualizada foi resgatada da Distribuidora Local e anexada na aba de Devolutivas do seu escritório iGreen para reanálise. A sua pendência foi resolvida!",
    T_RESGATE_FAIL: "⚠️ Ocorreu um erro ao tentar buscar a fatura ou acessar o painel da iGreen. Por favor, verifique se o CPF, Nascimento e UC estão corretos.",

    T_GUARDAR_START: "Opção 2️⃣ selecionada! 💾 \n*Módulo de Pré-Cadastro* ativado!\nPor favor, envie a foto ou PDF da sua *Fatura de Energia*.",
    T_PEDIR_TELEFONE: "✅ Fatura analisada e salva!\n👤 Titular: ${nome}\n⚡ UC: ${uc}\n\nPara completarmos o seu pré-cadastro, digite o **Número de Telefone (com DDD)** do titular:",
    T_PEDIR_EMAIL: "Ótimo! 📱 Telefone salvo.\n\nAgora, por favor, digite o **melhor E-mail** do titular:",
    T_FIM_PRE_CADASTRO: "Perfeito! 📧 E-mail salvo no seu perfil.\n\n⚠️ *Aviso:* O seu cadastro está 'Pendente de Documentos'. Quando quiser enviar a foto do seu documento (Frente e Verso), escolha a **Opção 4** no menu inicial.",
    
    T_START_OPCAO_4: "Opção 4️⃣ selecionada! 📎\nPara anexarmos o documento no cadastro correto, digite o número da sua **UC ou Conta Contrato** (apenas os números):",
    T_OP4_FALTANDO_TEL: "🔍 Localizei o seu cadastro, mas ainda não temos o seu **Telefone**. Digite-o com DDD para atualizarmos:",
    T_OP4_FALTANDO_MAIL: "Certo! E qual o seu melhor **E-mail**?",
    T_PEDIR_FOTO_DOC_FRENTE: "✅ Cadastro atualizado e pronto! \n\nPor favor, envie agora uma foto legível apenas da **FRENTE** do seu Documento de Identificação (RG ou CNH):",
    T_PEDIR_FOTO_DOC_VERSO: "✅ Frente recebida!\n\nAgora, envie a foto do **VERSO** do mesmo documento:",
    T_DOCS_RECEBIDOS: "✅ Documentos recebidos com sucesso! \nAs imagens foram anexadas ao seu perfil com segurança. Muito obrigado! 🙏"
};

const CHROME_ARGS = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", 
    "--disable-gpu", "--no-zygote", 
    "--user-agent=Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Mobile Safari/537.36"
];

// ==========================================
// FUNÇÕES AUXILIARES
// ==========================================
async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try { 
        await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
        { phone: numLimpo, message: String(message) }, 
        { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN, 'Content-Type': 'application/json' } }); 
    } catch (e) { console.error(`[Z-API] Erro:`, e.message); }
}

async function buscarNoBanco(docId) {
    if (admin.apps.length > 0) {
        try {
            const db = admin.firestore();
            const doc = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(docId).get();
            return doc.exists ? doc.data() : null;
        } catch (e) { return null; }
    }
    return null;
}

function limparDadosVazios(dados) {
    return Object.fromEntries(Object.entries(dados).filter(([_, v]) => v !== "" && v !== "Não extraído" && v !== "0" && v !== null && v !== undefined));
}

async function salvarNoBanco(docId, phone, dadosExtras) {
    if (admin.apps.length > 0) {
        try {
            const db = admin.firestore();
            const dadosLimpos = limparDadosVazios(dadosExtras); 
            await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(docId).set(
                { ...dadosLimpos, TELEFONE_REMETENTE: phone, DATA_ULTIMA_ATUALIZACAO: admin.firestore.FieldValue.serverTimestamp() }, 
                { merge: true } 
            );
        } catch (e) { console.error("Erro Firebase:", e.message); }
    }
}

// ==========================================
// MÓDULO 1: MOTOR IA
// ==========================================
async function analisarFaturaGemini(mediaUrl, mimeType) {
    const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
    const base64Data = Buffer.from(response.data, 'binary').toString('base64');
    const instrucao = `Auditor iGreen. Regra Média: Soma últimos 6 meses (ou disponíveis) / quantidade de meses.`;
    const payload = {
        systemInstruction: { parts: [{ text: instrucao }] },
        contents: [{ parts: [{ text: "Extraia os dados organizadamente." }, { inlineData: { mimeType, data: base64Data } }] }],
        generationConfig: { 
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    "DISTRIBUIDORA": { type: "STRING" }, "NOME_CLIENTE": { type: "STRING" }, "MASCARA_CPF": { type: "STRING" }, "CPF": { type: "STRING" },
                    "ENDERECO": { type: "STRING" }, "ENDERECO_NUMERO": { type: "STRING" }, "ENDERECO_COMPLEMENTO": { type: "STRING" },
                    "BAIRRO": { type: "STRING" }, "CIDADE": { type: "STRING" }, "ESTADO": { type: "STRING" }, "CEP": { type: "STRING" },
                    "UC": { type: "STRING" }, "CONTA_MES": { type: "STRING" }, "VENCIMENTO": { type: "STRING" }, "VALOR_FATURA": { type: "STRING" }, "MEDIA_CONSUMO": { type: "STRING" }
                }
            }
        }
    };
    const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY.trim()}`, payload);
    return JSON.parse(res.data.candidates[0].content.parts[0].text);
}

// ==========================================
// MÓDULO 2: EXTRATOR RPA (DEVOLUTIVAS MAPEADAS)
// ==========================================
async function fluxoResgateDevolutiva(cpf, nascimento, uc, phone, isAutomated = false) {
    let browser;
    const caminhoFaturaLocal = path.join('/tmp', `fatura_${Date.now()}.pdf`);
    let pdfInterceptado = false;

    try {
        browser = await puppeteer.launch({ headless: true, args: CHROME_ARGS });
        const page = await browser.newPage();
        
        // INTERCEPTADOR: Configura o robô para roubar o PDF da rede quando ele tentar abrir
        page.on('response', async (response) => {
            const contentType = response.headers()['content-type'];
            if (contentType && contentType.includes('application/pdf')) {
                console.log("[RPA] ✅ PDF Detectado na rede! Capturando buffer...");
                const buffer = await response.buffer();
                fs.writeFileSync(caminhoFaturaLocal, buffer);
                pdfInterceptado = true;
                console.log("[RPA] 📄 Arquivo PDF gravado com sucesso no servidor.");
            }
        });
        
        // --- ETAPA A: DISTRIBUIDORA LOCAL (EQUATORIAL AL) ---
        console.log(`[RPA] Acessando Equatorial AL -> Doc: ${cpf} | Nasc: ${nascimento}`);
        await page.goto(EQUATORIAL_AL_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        // 1. Termos de Privacidade ("Li e Entendi" e "Enviar")
        try {
            await page.evaluate(() => {
                const check = document.querySelector('input[type="checkbox"]');
                if(check) check.click();
                const btnEnviar = Array.from(document.querySelectorAll('button, div, span')).find(el => el.textContent.toUpperCase().includes('ENVIAR'));
                if(btnEnviar) btnEnviar.click();
                const btnFechar = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.toUpperCase().includes('FECHAR'));
                if(btnFechar) btnFechar.click();
            });
            await new Promise(r => setTimeout(r, 2000));
        } catch(e) { console.log("[RPA] Banner LGPD não encontrado, seguindo..."); }

        // 2. Login (CPF e Nascimento)
        // O robô tenta achar qualquer input que pareça CPF ou Nascimento usando seletores genéricos e seguros
        await page.evaluate((cpfBusca, nascBusca) => {
            const inputs = document.querySelectorAll('input');
            inputs.forEach(input => {
                if (input.placeholder.toLowerCase().includes('cpf') || input.placeholder.toLowerCase().includes('cnpj')) input.value = cpfBusca;
                if (input.placeholder.toLowerCase().includes('nascimento') || input.placeholder.toLowerCase().includes('data')) input.value = nascBusca;
            });
            const btnEntrar = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toUpperCase().includes('ENTRAR'));
            if(btnEntrar) btnEntrar.click();
        }, cpf, nascimento);
        await new Promise(r => setTimeout(r, 5000));

        // 3. Selecionar a Conta Contrato (UC)
        console.log(`[RPA] Procurando e selecionando a UC Exata: ${uc}...`);
        await page.evaluate((alvoUc) => {
            const btnSair = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.toUpperCase().includes('SAIR'));
            if(btnSair) btnSair.click(); // Limpa caixinha se estiver preenchida com outro imóvel
            
            // Clica na UC correspondente na lista que aparecer
            const elemUc = Array.from(document.querySelectorAll('span, div, option, li, p')).find(el => el.textContent.includes(alvoUc));
            if(elemUc) elemUc.click();
        }, uc);
        await new Promise(r => setTimeout(r, 3000));

        // 4. Clicar em "Emitir segunda via e consultar débito"
        await page.evaluate(() => {
            const btn2via = Array.from(document.querySelectorAll('span, a, div, button')).find(el => el.textContent.toLowerCase().includes('segunda via'));
            if(btn2via) btn2via.click();
        });
        await new Promise(r => setTimeout(r, 4000));

        // 5. Clicar no Valor (R$) e "VER FATURA"
        await page.evaluate(() => {
            const valorFatura = Array.from(document.querySelectorAll('span, td, div')).find(el => el.textContent.includes('R$'));
            if(valorFatura) valorFatura.click();
        });
        await new Promise(r => setTimeout(r, 2000));

        await page.evaluate(() => {
            const btnVerFatura = Array.from(document.querySelectorAll('button, a, span')).find(el => el.textContent.toUpperCase().includes('VER FATURA'));
            if(btnVerFatura) btnVerFatura.click();
        });
        
        console.log("[RPA] Aguardando o download do PDF em background...");
        await new Promise(r => setTimeout(r, 8000)); // Espera 8 segundos pro PDF ser capturado pela rede
        
        // Verifica se o PDF foi baixado
        if (!fs.existsSync(caminhoFaturaLocal)) {
            throw new Error("Falha ao capturar o PDF na Equatorial.");
        }

        // --- ETAPA B: INJEÇÃO NA IGREEN ---
        console.log(`[RPA] Etapa A concluída! Acessando portal iGreen para injeção...`);
        await page.goto(IGREEN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        try { await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Começar')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}

        await page.waitForSelector('input[type="email"]');
        await page.type('input[type="email"]', IGREEN_USER);
        await page.type('input[type="password"]', IGREEN_PASS);
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 6000));

        try { await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent.includes('Agora não')); if(btn) btn.click(); }); await new Promise(r => setTimeout(r, 2000)); } catch(e){}

        await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('span, div')).find(el => el.textContent.trim() === 'Clientes'); if(btn) btn.click(); });
        await new Promise(r => setTimeout(r, 4000));

        await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('span, div, p')).find(el => el.textContent.trim() === 'Green'); if(btn) btn.click(); });
        await new Promise(r => setTimeout(r, 4000));

        // 1. Pesquisa CPF na iGreen
        console.log(`[RPA] Pesquisando cliente pelo CPF: ${cpf}...`);
        const searchInput = await page.waitForSelector('input[placeholder*="Pesquisar"]');
        await searchInput.type(cpf);
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 4000));

        // 2. Trava de segurança: Acha a linha exata da UC
        console.log(`[RPA] Cruzando dados: Procurando a UC ${uc} na lista de imóveis...`);
        await page.evaluate((alvoUc) => { 
            const linhas = Array.from(document.querySelectorAll('tr')); 
            const linhaExata = linhas.find(row => row.textContent.includes(alvoUc)); 
            if(linhaExata) {
                const btnTresPontinhos = Array.from(linhaExata.querySelectorAll('button, div')).find(el => el.textContent.trim() === '...'); 
                if(btnTresPontinhos) btnTresPontinhos.click(); 
            }
        }, uc);
        await new Promise(r => setTimeout(r, 2000));

        // 3. Menu Devolutivas > Realizar ação
        await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('span, li, div')).find(el => el.textContent.includes('Devolutivas')); if(btn) btn.click(); });
        await new Promise(r => setTimeout(r, 3000));

        await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('button, span, div')).find(el => el.textContent.includes('Realizar ação')); if(btn) btn.click(); });
        await new Promise(r => setTimeout(r, 3000));

        // 4. O UPLOAD FÍSICO DO ARQUIVO PDF
        console.log(`[RPA] Realizando UPLOAD do documento atualizado na iGreen...`);
        const [fileChooser] = await Promise.all([
            page.waitForFileChooser(),
            // Clica no botão que aciona a janela de seleção de arquivo do Windows/Navegador
            page.evaluate(() => { 
                const b = Array.from(document.querySelectorAll('*')).find(el => el.textContent.includes('Selecionar arquivo') || el.type === 'file'); 
                if (b) b.click(); 
            })
        ]);
        // Injeta o arquivo do servidor no botão virtual
        await fileChooser.accept([caminhoFaturaLocal]);
        await new Promise(r => setTimeout(r, 2000));

        // 5. Clica no botão final de enviar/salvar
        await page.evaluate(() => { 
            const btnSalvar = Array.from(document.querySelectorAll('button')).find(el => el.textContent.toUpperCase().includes('ENVIAR') || el.textContent.toUpperCase().includes('SALVAR')); 
            if (btnSalvar) btnSalvar.click(); 
        });
        await new Promise(r => setTimeout(r, 4000));
        
        await browser.close();

        // Apaga o arquivo temporário do servidor para não lotar o disco
        fs.unlinkSync(caminhoFaturaLocal);

        if(!isAutomated) await enviarMensagem(phone, TEXTOS.T_RESGATE_SUCESSO);
        
    } catch (e) { 
        console.error("Erro RPA Devolutivas:", e);
        if(browser) await browser.close(); 
        if(fs.existsSync(caminhoFaturaLocal)) fs.unlinkSync(caminhoFaturaLocal); // Apaga lixo se der erro
        if(!isAutomated) await enviarMensagem(phone, TEXTOS.T_RESGATE_FAIL);
    }
}

// ==========================================
// MÓDULO 3: MOTOR RECORRENTE (A CADA 24H)
// ==========================================
function iniciarMotorRecorrente() {
    setInterval(async () => {
        console.log("⏳ [CRON] Iniciando varredura diária...");
        if (admin.apps.length > 0) {
            try {
                const db = admin.firestore();
                const snapshot = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads')
                                        .where('STATUS_CADASTRO', '==', 'PENDENTE_MEDIA').get();
                
                snapshot.forEach(async (doc) => {
                    const lead = doc.data();
                    const ultimaVerificacao = lead.DATA_ULTIMA_ATUALIZACAO ? lead.DATA_ULTIMA_ATUALIZACAO.toDate() : new Date();
                    const diasPassados = Math.floor((new Date() - ultimaVerificacao) / (1000 * 60 * 60 * 24));
                    
                    if (diasPassados >= 15) {
                        console.log(`🔄 [CRON] 15 dias atingidos. RPA automático para UC: ${lead.UC}`);
                        fluxoResgateDevolutiva(lead.CPF, lead.DATA_NASCIMENTO, lead.UC, lead.TELEFONE_REMETENTE, true);
                        await salvarNoBanco(doc.id, lead.TELEFONE_REMETENTE, { STATUS_CADASTRO: 'PENDENTE_MEDIA' }); 
                    }
                });
            } catch (e) { console.error("Erro no Cron:", e.message); }
        }
    }, 86400000); 
}
iniciarMotorRecorrente();

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
        if (txtL === '3') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DADOS_DEVOLUTIVA' }); await enviarMensagem(phone, TEXTOS.T_RESGATE_START); return; }
        if (txtL === '4') { memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_UC_DOC' }); await enviarMensagem(phone, TEXTOS.T_START_OPCAO_4); return; }
        await enviarMensagem(phone, TEXTOS.T_MENU);
        return;
    }

    switch (mem.STATUS_CADASTRO) {
        case 'AGUARDANDO_FATURA': {
            if (temMidia) {
                await enviarMensagem(phone, TEXTOS.T02); 
                try {
                    const dadosIA = await analisarFaturaGemini(mediaUrl, mimeType);
                    const docId = dadosIA.UC ? dadosIA.UC.replace(/\D/g, '') : `SEM_UC_${Date.now()}`;
                    await salvarNoBanco(docId, phone, { ...dadosIA, LINK_FATURA: mediaUrl, STATUS_CADASTRO: "CONCLUIDO" });
                    await enviarMensagem(phone, `✅ Tudo certo! Titular: ${dadosIA.NOME_CLIENTE}. Especialista entrará em contato.`);
                    memoriaEstado.delete(phone); 
                } catch (e) { await enviarMensagem(phone, "❌ Erro ao ler fatura."); }
            } else { await enviarMensagem(phone, "⚠️ Aguardando foto/PDF da fatura."); }
            break;
        }

        case 'AGUARDANDO_FATURA_SOH_BANCO': {
            if (temMidia) {
                await enviarMensagem(phone, TEXTOS.T02); 
                try {
                    const dadosIA = await analisarFaturaGemini(mediaUrl, mimeType);
                    const docId = dadosIA.UC ? dadosIA.UC.replace(/\D/g, '') : `SEM_UC_${Date.now()}`;
                    await salvarNoBanco(docId, phone, { ...dadosIA, LINK_FATURA: mediaUrl, STATUS_CADASTRO: "AGUARDANDO_TELEFONE" });
                    memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_TELEFONE', docId });
                    await enviarMensagem(phone, TEXTOS.T_PEDIR_TELEFONE.replace('${nome}', dadosIA.NOME_CLIENTE).replace('${uc}', dadosIA.UC));
                } catch (e) { await enviarMensagem(phone, "❌ Erro na análise."); }
            } else { await enviarMensagem(phone, "⚠️ Aguardando foto/PDF da fatura."); }
            break;
        }

        case 'AGUARDANDO_TELEFONE': {
            if (textoIn.length >= 8) { 
                await salvarNoBanco(mem.docId, phone, { TELEFONE: textoIn, STATUS_CADASTRO: "AGUARDANDO_EMAIL" });
                memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_EMAIL', docId: mem.docId });
                await enviarMensagem(phone, TEXTOS.T_PEDIR_EMAIL);
            } else { await enviarMensagem(phone, "⚠️ Digite um telefone válido."); }
            break;
        }

        case 'AGUARDANDO_EMAIL': {
            if (textoIn.includes('@')) { 
                await salvarNoBanco(mem.docId, phone, { EMAIL: textoIn, STATUS_CADASTRO: "PENDENTE_DOCUMENTOS" });
                await enviarMensagem(phone, TEXTOS.T_FIM_PRE_CADASTRO);
                memoriaEstado.delete(phone);
            } else { await enviarMensagem(phone, "⚠️ Digite um e-mail válido."); }
            break;
        }

        case 'AGUARDANDO_DADOS_DEVOLUTIVA': {
            const dadosSplit = textoIn.split(' ').filter(v => v.trim() !== '');
            if (dadosSplit.length >= 3) {
                const cpf = dadosSplit[0].replace(/\D/g, ''); 
                const nascimento = dadosSplit[1]; 
                const uc = dadosSplit[2].replace(/\D/g, ''); 
                
                await enviarMensagem(phone, TEXTOS.T_RESGATE_BUSCANDO);
                memoriaEstado.delete(phone); 
                
                setTimeout(() => { fluxoResgateDevolutiva(cpf, nascimento, uc, phone, false); }, 2000);
            } else {
                await enviarMensagem(phone, "⚠️ Formato inválido. Digite o CPF, Data de Nascimento e UC separados por espaço.");
            }
            break;
        }

        case 'AGUARDANDO_UC_DOC': {
            if (textoIn.length >= 4) { 
                const ucLimpa = textoIn.replace(/\D/g, '');
                const leadExistente = await buscarNoBanco(ucLimpa);
                
                if (leadExistente) {
                    if (!leadExistente.TELEFONE) {
                        memoriaEstado.set(phone, { STATUS_CADASTRO: 'OP4_PEDIR_TELEFONE', docId: ucLimpa });
                        await enviarMensagem(phone, TEXTOS.T_OP4_FALTANDO_TEL);
                    } else if (!leadExistente.EMAIL) {
                        memoriaEstado.set(phone, { STATUS_CADASTRO: 'OP4_PEDIR_EMAIL', docId: ucLimpa });
                        await enviarMensagem(phone, TEXTOS.T_OP4_FALTANDO_MAIL);
                    } else {
                        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE', docId: ucLimpa });
                        await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_FRENTE);
                    }
                } else {
                    memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE', docId: ucLimpa });
                    await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_FRENTE);
                }
            } else { await enviarMensagem(phone, "⚠️ Digite a UC corretamente."); }
            break;
        }

        case 'OP4_PEDIR_TELEFONE': {
            if (textoIn.length >= 8) {
                await salvarNoBanco(mem.docId, phone, { TELEFONE: textoIn });
                const leadAtualizadoTel = await buscarNoBanco(mem.docId);
                
                if (leadAtualizadoTel && !leadAtualizadoTel.EMAIL) {
                    memoriaEstado.set(phone, { STATUS_CADASTRO: 'OP4_PEDIR_EMAIL', docId: mem.docId });
                    await enviarMensagem(phone, TEXTOS.T_OP4_FALTANDO_MAIL);
                } else {
                    memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE', docId: mem.docId });
                    await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_FRENTE);
                }
            } else { await enviarMensagem(phone, "⚠️ Digite um telefone válido."); }
            break;
        }

        case 'OP4_PEDIR_EMAIL': {
            if (textoIn.includes('@')) {
                await salvarNoBanco(mem.docId, phone, { EMAIL: textoIn });
                memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE', docId: mem.docId });
                await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_FRENTE);
            } else { await enviarMensagem(phone, "⚠️ Digite um e-mail válido."); }
            break;
        }

        case 'AGUARDANDO_DOC_FRENTE': {
            if (temMidia) {
                await salvarNoBanco(mem.docId, phone, { LINK_DOC_FRENTE: mediaUrl });
                memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_VERSO', docId: mem.docId });
                await enviarMensagem(phone, TEXTOS.T_PEDIR_FOTO_DOC_VERSO);
            } else { await enviarMensagem(phone, "⚠️ Envie a foto da FRENTE."); }
            break;
        }

        case 'AGUARDANDO_DOC_VERSO': {
            if (temMidia) {
                await salvarNoBanco(mem.docId, phone, { LINK_DOC_VERSO: mediaUrl, STATUS_CADASTRO: "CONCLUIDO_COM_DOCS" });
                await enviarMensagem(phone, TEXTOS.T_DOCS_RECEBIDOS);
                memoriaEstado.delete(phone);
            } else { await enviarMensagem(phone, "⚠️ Envie a foto do VERSO."); }
            break;
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));    
