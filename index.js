import axios from 'axios';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.error("❌ GEMINI_API_KEY não definida!");
    process.exit(1);
}

const chaveLimpa = String(GEMINI_API_KEY).trim();

// Lista de modelos pra testar
const modelos = [
    { nome: "gemini-1.5-flash", versao: "v1beta" },
    { nome: "gemini-2.0-flash-exp", versao: "v1beta" },
    { nome: "gemini-1.5-pro", versao: "v1beta" },
    { nome: "gemini-pro", versao: "v1" }
];

async function testarModelo(modelo) {
    try {
        const endpoint = `https://generativelanguage.googleapis.com/${modelo.versao}/models/${modelo.nome}:generateContent?key=${chaveLimpa}`;
        
        console.log(`\n🔍 Testando: ${modelo.nome} (${modelo.versao})...`);
        
        const payload = {
            contents: [{ 
                parts: [{ 
                    text: "Responda com um JSON simples: {\"status\": \"ok\"}" 
                }] 
            }],
            generationConfig: { responseMimeType: "application/json" }
        };

        const response = await axios.post(endpoint, payload, { timeout: 15000 });
        
        if (response.data.candidates && response.data.candidates[0].content.parts[0].text) {
            console.log(`✅ ${modelo.nome} FUNCIONA!`);
            console.log(`   Resposta: ${response.data.candidates[0].content.parts[0].text}`);
            return { modelo: modelo.nome, status: "OK", versao: modelo.versao };
        }
    } catch (error) {
        const statusCode = error.response?.status;
        const errorMsg = error.response?.data?.error?.message || error.message;
        
        console.log(`❌ ${modelo.nome} FALHOU`);
        console.log(`   Status: ${statusCode}`);
        console.log(`   Erro: ${errorMsg}`);
        
        return { modelo: modelo.nome, status: "FALHOU", codigo: statusCode, erro: errorMsg };
    }
}

async function executarTestes() {
    console.log("🚀 INICIANDO TESTES DE MODELOS GEMINI\n");
    console.log("=".repeat(60));
    
    const resultados = [];
    
    for (const modelo of modelos) {
        const resultado = await testarModelo(modelo);
        resultados.push(resultado);
        
        // Aguarda 2s entre testes pra não sobrecarregar
        await new Promise(r => setTimeout(r, 2000));
    }
    
    console.log("\n" + "=".repeat(60));
    console.log("\n📊 RESUMO DOS TESTES:\n");
    
    const funcionando = resultados.filter(r => r.status === "OK");
    const falhados = resultados.filter(r => r.status === "FALHOU");
    
    if (funcionando.length > 0) {
        console.log("✅ MODELOS FUNCIONANDO:");
        funcionando.forEach(r => {
            console.log(`   • ${r.modelo} (${r.versao})`);
        });
    }
    
    if (falhados.length > 0) {
        console.log("\n❌ MODELOS QUE FALHARAM:");
        falhados.forEach(r => {
            console.log(`   • ${r.modelo} - Código ${r.codigo}`);
        });
    }
    
    console.log("\n" + "=".repeat(60));
    console.log("\n💡 RECOMENDAÇÃO:");
    
    if (funcionando.length > 0) {
        const recomendado = funcionando[0];
        console.log(`\nUse: ${recomendado.modelo} (${recomendado.versao})`);
        console.log(`\nAtualize seu código com este modelo como primeira opção.`);
    } else {
        console.log("\n⚠️ NENHUM MODELO FUNCIONOU!");
        console.log("Verifique:");
        console.log("  1. Se GEMINI_API_KEY está correta");
        console.log("  2. Se a chave tem permissão pra usar Gemini API");
        console.log("  3. Se você não excedeu a quota de requisições");
    }
}

executarTestes();
