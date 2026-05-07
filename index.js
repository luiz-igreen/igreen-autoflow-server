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
    
    // Textos do Fluxo de Nascimento e Opção 4
    T_PEDIR_NASCIMENTO: "✅ Fatura analisada e salva com segurança!\n👤 Titular: ${nome}\n📄 CPF: ${cpf}\n⚡ Média de consumo: ${media} kWh.\n\nPara facilitar emissões de *Segunda Via* no futuro, por favor, digite a sua **Data de Nascimento** (Ex: 15/08/1985):",
    T_FIM_PRE_CADASTRO: "Obrigado! 📅 Data de nascimento salva no seu perfil.\n\n⚠️ *Aviso Importante:* O seu cadastro está 'Pendente de Documentos'. Como você já é cliente iGreen, não há pressa! Quando quiser atualizar nosso sistema com a foto do seu documento (RG ou CNH), basta voltar a este atendimento e escolher a **Opção 4**.",
    T_START_OPCAO_4: "Opção 4️⃣ selecionada! 📎\nPor favor, envie a foto legível do seu **Documento de Identificação (RG ou CNH)** para atualizarmos o seu cadastro:",
    T_DOCS_RECEBIDOS: "✅ Documento recebido com sucesso! \nO arquivo foi anexado ao seu perfil com segurança para futuras necessidades. Muito obrigado pela sua colaboração! 🙏"
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
// MÓDULO 1: MOTOR IA (GEMINI 3 FLASH PREVIEW)
// ==========================================
async function analisarFaturaGemini(mediaUrl, mimeType) {
    if (!GEMINI_API_KEY) {
        console.error("❌ ERRO FATAL: Chave GEMINI_API_KEY não foi encontrada.");
        throw new Error("Chave do Gemini ausente no Cofre do Servidor.");
    }
    
    const chaveLimpa = String(GEMINI_API_KEY).trim();

    console.log(`[GEMINI] Baixando documento: ${mediaUrl}`);
    const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
    const base64Data = Buffer.from(response.data, 'binary').toString('base64');
    
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

    const endpointFinal = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${chaveLimpa}`;

    let tentativas = 3;
    let atraso = 1000;

    console.log(`[GEMINI] Conectando na API Oficial Estável...`);

    while (tentativas > 0) {
        try {
            const aiRes = await axios.post(endpointFinal, payload);
            console.log(`[GEMINI] ✅ Sucesso! Dados extraídos.`);
            return JSON.parse(aiRes.data.candidates[0].content.parts[0].text);
            
        } catch (error) {
            tentativas--;
            if (tentativas === 0) {
                const erroGoogle = error.response?.data ? JSON.stringify(error.response.data, null, 2) : error.message;
                console.error("❌ [ERRO FATAL GEMINI]:\n", erroGoogle);
                throw new Error("A Inteligência Artificial recusou o documento.");
            }
            console.warn(`[GEMINI] Tentando novamente em ${atraso}ms...`);
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
        console.log(`[EXTRATOR] ⚠️ Iniciando Navegador RPA...`);
        browser = await puppeteer.launch({ headless: true, args: CHROME_ARGS });
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
        
        if (txtL === '4' || ['enviar', 'documentos', 'rg', 'cnh'].includes(txtL)) {
            memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOCUMENTOS_AVULSOS' });
            await enviarMensagem(phone, TEXTOS.T_START_OPCAO_4); 
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

                    await enviarMensagem(phone, `✅ Tudo certo com a sua fatura!\n👤 Titular: ${dadosIA.NOME_CLIENTE}\n⚡ Média de consumo: ${dadosIA.MEDIA_CONSUMO} kWh.\n\nOs seus dados já foram validados pela nossa equipe. Um de nossos especialistas vai preparar o seu contrato com o desconto garantido e entrará em contato em breve!`);
                    memoriaEstado.delete(phone); 
                } catch (error) {
                    await enviarMensagem(phone, "❌ Tive uma dificuldade técnica ao ler este documento. Poderia enviar novamente uma foto mais nítida?");
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
                        STATUS_CADASTRO: "AGUARDANDO_NASCIMENTO" 
                    });

                    memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_NASCIMENTO' });

                    const msgNasc = TEXTOS.T_PEDIR_NASCIMENTO
                        .replace('${nome}', dadosIA.NOME_CLIENTE)
                        .replace('${cpf}', dadosIA.CPF)
                        .replace('${media}', dadosIA.MEDIA_CONSUMO);
                    
                    await enviarMensagem(phone, msgNasc);
                } catch (error) {
                    await enviarMensagem(phone, "❌ Tive uma dificuldade técnica ao ler este documento. Poderia enviar novamente?");
                }
            } else {
                await enviarMensagem(phone, "⚠️ Aguardando a sua Fatura. Envie a imagem/PDF ou digite *0* para cancelar.");
            }
            break;

        case 'AGUARDANDO_NASCIMENTO':
            if (textoIn.length >= 8) { 
                await salvarNoBanco(phone, { DATA_NASCIMENTO: textoIn });
                await enviarMensagem(phone, TEXTOS.T_FIM_PRE_CADASTRO);
                memoriaEstado.delete(phone); 
            } else {
                await enviarMensagem(phone, "⚠️ Por favor, digite uma data de nascimento válida (Ex: 25/04/1990) ou digite *0* para cancelar.");
            }
            break;

        case 'AGUARDANDO_TERMO_RESGATE':
            if (textoIn.length >= 2) {
                await enviarMensagem(phone, TEXTOS.T_RESGATE_BUSCANDO);
                memoriaEstado.delete(phone); 
                setTimeout(() => { fluxoExtracaoDados(textoIn, phone); }, 3000);
            } else {
                await enviarMensagem(phone, "⚠️ Digite o Nome completo ou ID para buscar. Ou digite *0* para voltar ao menu.");
            }
            break;
            
        case 'AGUARDANDO_DOCUMENTOS_AVULSOS': 
            if (temMidia) {
                try {
                    await salvarNoBanco(phone, {
                        LINK_DOCUMENTO_ID: mediaUrl,
                        STATUS_CADASTRO: "CONCLUIDO_COM_DOCS" 
                    });
                    await enviarMensagem(phone, TEXTOS.T_DOCS_RECEBIDOS);
                    memoriaEstado.delete(phone);
                } catch (error) {
                    await enviarMensagem(phone, "⚠️ Erro ao salvar o documento. Tente novamente.");
                }
            } else {
                await enviarMensagem(phone, "⚠️ Por favor, envie a foto do seu documento (RG ou CNH) ou digite *0* para voltar ao menu inicial.");
            }
            break;
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
