import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, onSnapshot } from 'firebase/firestore';
import { Search, Download, Database, Leaf, Mic, Terminal, Bot, Zap, CheckCircle2, Wifi } from 'lucide-react';

const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'igreen-autoflow-v4';

export default function App() {
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState('AUDITORIA_IGREEN');
  const [searchTerm, setSearchTerm] = useState("");
  
  // ESTADOS AGORA COMEÇAM 100% VAZIOS (AGUARDANDO O BANCO DE DADOS REAL)
  const [leads, setLeads] = useState([]); 
  const [historicoVoz, setHistoricoVoz] = useState([]);
  const [filaRpa, setFilaRpa] = useState([]);
  const [debugZapi, setDebugZapi] = useState([]);

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Erro auth:", error);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // SINCRONIZAÇÃO DEFINITIVA COM O FIRESTORE
  useEffect(() => {
    if (!user) return;
    
    // Inscrição: AUDITORIA_IGREEN (leads)
    const unsubLeads = onSnapshot(query(collection(db, 'artifacts', appId, 'public', 'data', 'leads')), 
      (snapshot) => setLeads(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a,b) => (b.DATA_PROCESSAMENTO?.toMillis() || 0) - (a.DATA_PROCESSAMENTO?.toMillis() || 0))),
      (error) => console.error("Erro Leads:", error)
    );

    // Inscrição: HISTORICO_VOZ
    const unsubVoz = onSnapshot(query(collection(db, 'artifacts', appId, 'public', 'data', 'historico_voz')), 
      (snapshot) => setHistoricoVoz(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a,b) => (b.DATA_HORA?.toMillis() || 0) - (a.DATA_HORA?.toMillis() || 0))),
      (error) => console.error("Erro Voz:", error)
    );

    // Inscrição: FILA_RPA_IGREEN
    const unsubRpa = onSnapshot(query(collection(db, 'artifacts', appId, 'public', 'data', 'fila_rpa')), 
      (snapshot) => setFilaRpa(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a,b) => (b.DATA_INTEGRACAO?.toMillis() || 0) - (a.DATA_INTEGRACAO?.toMillis() || 0))),
      (error) => console.error("Erro RPA:", error)
    );

    // Inscrição: DEBUG_ZAPI
    const unsubDebug = onSnapshot(query(collection(db, 'artifacts', appId, 'public', 'data', 'debug_zapi')), 
      (snapshot) => setDebugZapi(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a,b) => (b.DATA?.toMillis() || 0) - (a.DATA?.toMillis() || 0))),
      (error) => console.error("Erro Debug:", error)
    );
    
    return () => { unsubLeads(); unsubVoz(); unsubRpa(); unsubDebug(); };
  }, [user]);

  const formatDate = (timestamp) => {
    if (!timestamp) return "-";
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    if (isNaN(date.getTime())) return "-";
    return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const renderAuditoria = () => {
    const filtrados = leads.filter(l => (l.NOME_CLIENTE || "").toLowerCase().includes(searchTerm.toLowerCase()) || (l.UC || "").includes(searchTerm));
    
    return (
      <div className="overflow-x-auto pb-4">
        <table className="w-full text-left whitespace-nowrap mt-4">
          <thead>
            <tr className="bg-slate-100 border-b border-slate-200 text-[10px] font-black uppercase tracking-wider text-slate-600">
              <th className="p-3 sticky left-0 bg-slate-100 z-10 shadow-[1px_0_0_#e2e8f0]">DATA_PROCESSAMENTO</th>
              <th className="p-3">STATUS_CADASTRO</th>
              <th className="p-3">TELEFONE</th>
              <th className="p-3">NOME_CLIENTE</th>
              <th className="p-3">MASCARA_CPF</th>
              <th className="p-3">CPF</th>
              <th className="p-3">MASCARA_CNPJ</th>
              <th className="p-3">CNPJ</th>
              <th className="p-3">DATA_NASCIMENTO</th>
              <th className="p-3">EMAIL</th>
              <th className="p-3">CEP</th>
              <th className="p-3">ENDERECO</th>
              <th className="p-3">ENDERECO_NUMERO</th>
              <th className="p-3">ESTADO</th>
              <th className="p-3">DISTRIBUIDORA</th>
              <th className="p-3">TIPO_LIGACAO</th>
              <th className="p-3">UC</th>
              <th className="p-3 text-center">VALOR_FATURA</th>
              <th className="p-3 text-center">ELEGIVEL</th>
              <th className="p-3 text-center">MEDIA_CONSUMO</th>
              <th className="p-3 text-center">LINK_FATURA</th>
              <th className="p-3 text-center">LINK_DOC_FRENTE</th>
              <th className="p-3 text-center">LINK_DOC_VERSO</th>
              {[...Array(12)].map((_, i) => <th key={i} className="p-3 text-center">CONSUMO_MES_{i+1}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtrados.length === 0 && (
              <tr>
                  <td colSpan="35" className="p-12 text-center text-slate-400">
                      <Database className="w-10 h-10 mx-auto text-slate-300 mb-3" />
                      <p className="font-bold text-sm">Banco de Dados Vazio ou Aguardando Faturas</p>
                      <p className="text-xs mt-1">Envie a primeira fatura para o WhatsApp e ela aparecerá aqui instantaneamente.</p>
                  </td>
              </tr>
            )}
            {filtrados.map((lead) => (
              <tr key={lead.id} className="hover:bg-emerald-50/50 text-[11px] text-slate-700">
                <td className="p-3 sticky left-0 bg-white shadow-[1px_0_0_#f1f5f9] font-mono">{formatDate(lead.DATA_PROCESSAMENTO)}</td>
                <td className="p-3">
                    {lead.STATUS_CADASTRO === 'CONCLUIDO' 
                        ? <span className="bg-emerald-100 text-emerald-800 px-2 py-1 rounded-md font-bold flex items-center gap-1 w-max"><CheckCircle2 className="w-3 h-3"/> CONCLUÍDO</span>
                        : <span className="bg-amber-100 text-amber-800 px-2 py-1 rounded-md font-bold">{lead.STATUS_CADASTRO || "NOVO"}</span>
                    }
                </td>
                <td className="p-3 font-mono">{lead.TELEFONE || "-"}</td>
                <td className="p-3 font-bold text-slate-900">{lead.NOME_CLIENTE || "-"}</td>
                <td className="p-3 font-mono text-slate-500">{lead.MASCARA_CPF || "-"}</td>
                <td className="p-3 font-mono">{lead.CPF || "-"}</td>
                <td className="p-3 font-mono text-slate-500">{lead.MASCARA_CNPJ || "-"}</td>
                <td className="p-3 font-mono">{lead.CNPJ || "-"}</td>
                <td className="p-3 font-mono">{lead.DATA_NASCIMENTO || "-"}</td>
                <td className="p-3 font-bold text-blue-600">{lead.EMAIL || "-"}</td>
                <td className="p-3 font-mono">{lead.CEP || "-"}</td>
                <td className="p-3 truncate max-w-[200px]" title={lead.ENDERECO}>{lead.ENDERECO || "-"}</td>
                <td className="p-3 font-bold">{lead.ENDERECO_NUMERO || "-"}</td>
                <td className="p-3 font-bold text-slate-800">{lead.ESTADO || "-"}</td>
                <td className="p-3">{lead.DISTRIBUIDORA || "-"}</td>
                <td className="p-3">{lead.TIPO_LIGACAO || "-"}</td>
                <td className="p-3 font-bold text-indigo-600">{lead.UC || "-"}</td>
                <td className="p-3 font-mono font-bold text-slate-800">R$ {lead.VALOR_FATURA || "0,00"}</td>
                <td className="p-3 text-center">
                  {lead.ELEGIVEL ? <span className="text-emerald-600 font-black flex items-center justify-center gap-1"><Zap className="w-3 h-3"/> SIM</span> : <span className="text-red-500 font-bold">NÃO</span>}
                </td>
                <td className="p-3 text-center font-black text-emerald-600 text-sm bg-emerald-50/50">{lead.MEDIA_CONSUMO || "0"}</td>
                
                <td className="p-3 text-center">
                  {lead.LINK_FATURA ? <a href={lead.LINK_FATURA} target="_blank" rel="noreferrer" className="text-blue-500 hover:text-blue-700 font-bold">Abrir Fatura</a> : "-"}
                </td>
                <td className="p-3 text-center">
                  {lead.LINK_DOC_FRENTE ? <a href={lead.LINK_DOC_FRENTE} target="_blank" rel="noreferrer" className="text-blue-500 hover:text-blue-700 font-bold">RG Frente</a> : "-"}
                </td>
                <td className="p-3 text-center">
                  {lead.LINK_DOC_VERSO ? <a href={lead.LINK_DOC_VERSO} target="_blank" rel="noreferrer" className="text-blue-500 hover:text-blue-700 font-bold">RG Verso</a> : "-"}
                </td>

                {[...Array(12)].map((_, i) => (
                  <td key={i} className="p-3 text-center bg-slate-50 border-l border-slate-200/50 font-mono font-semibold text-slate-600">
                    {lead[`CONSUMO_MES_${i+1}`] || "-"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderHistoricoVoz = () => (
    <div className="overflow-x-auto pb-4">
      <table className="w-full text-left whitespace-nowrap mt-4">
        <thead>
          <tr className="bg-slate-100 border-b border-slate-200 text-[10px] font-black uppercase tracking-wider text-slate-600">
            <th className="p-3">DATA_HORA</th>
            <th className="p-3">UTILIZADOR</th>
            <th className="p-3">VOZ</th>
            <th className="p-3">TEXTO_GERADO</th>
            <th className="p-3">FICHEIRO_GERADO</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {historicoVoz.length === 0 && <tr><td colSpan="5" className="p-12 text-center text-slate-400">Sem histórico de voz recente.</td></tr>}
          {historicoVoz.map((voz) => (
            <tr key={voz.id} className="hover:bg-emerald-50/50 text-[11px] text-slate-700">
              <td className="p-3">{formatDate(voz.DATA_HORA)}</td>
              <td className="p-3">{voz.UTILIZADOR || "SISTEMA"}</td>
              <td className="p-3 font-bold">{voz.VOZ || "Padrão"}</td>
              <td className="p-3 truncate max-w-[400px]" title={voz.TEXTO_GERADO}>{voz.TEXTO_GERADO || "-"}</td>
              <td className="p-3 text-blue-600">{voz.FICHEIRO_GERADO || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const renderFilaRpa = () => (
    <div className="overflow-x-auto pb-4">
      <table className="w-full text-left whitespace-nowrap mt-4">
        <thead>
          <tr className="bg-slate-100 border-b border-slate-200 text-[10px] font-black uppercase tracking-wider text-slate-600">
            <th className="p-3">DATA_INTEGRACAO</th>
            <th className="p-3">TIPO_PERFIL</th>
            <th className="p-3">DOCUMENTO_ID</th>
            <th className="p-3">NOME_RAZAO_SOCIAL</th>
            <th className="p-3">EMAIL</th>
            <th className="p-3">WHATSAPP</th>
            <th className="p-3">CEP</th>
            <th className="p-3">DISTRIBUIDORA</th>
            <th className="p-3">UC_INSTALACAO</th>
            <th className="p-3">CONSUMO_MEDIO_KWH</th>
            <th className="p-3 text-center">DOC_FATURA_LINK</th>
            <th className="p-3 text-center">DOC_IDENTIDADE_FRENTE</th>
            <th className="p-3 text-center">DOC_IDENTIDADE_VERSO</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filaRpa.length === 0 && <tr><td colSpan="13" className="p-12 text-center text-slate-400">Fila RPA vazia ou a aguardar aprovação.</td></tr>}
          {filaRpa.map((rpa) => (
            <tr key={rpa.id} className="hover:bg-emerald-50/50 text-[11px] text-slate-700">
              <td className="p-3">{formatDate(rpa.DATA_INTEGRACAO)}</td>
              <td className="p-3">{rpa.TIPO_PERFIL || "-"}</td>
              <td className="p-3">{rpa.DOCUMENTO_ID || "-"}</td>
              <td className="p-3 font-bold">{rpa.NOME_RAZAO_SOCIAL || "-"}</td>
              <td className="p-3">{rpa.EMAIL || "-"}</td>
              <td className="p-3">{rpa.WHATSAPP || "-"}</td>
              <td className="p-3">{rpa.CEP || "-"}</td>
              <td className="p-3">{rpa.DISTRIBUIDORA || "-"}</td>
              <td className="p-3 font-bold text-blue-600">{rpa.UC_INSTALACAO || "-"}</td>
              <td className="p-3 text-emerald-600 font-bold">{rpa.CONSUMO_MEDIO_KWH || "-"}</td>
              <td className="p-3 text-center">{rpa.DOC_FATURA_LINK ? <a href={rpa.DOC_FATURA_LINK} target="_blank" rel="noreferrer" className="text-blue-500">Link</a> : "-"}</td>
              <td className="p-3 text-center">{rpa.DOC_IDENTIDADE_FRENTE ? <a href={rpa.DOC_IDENTIDADE_FRENTE} target="_blank" rel="noreferrer" className="text-blue-500">Link</a> : "-"}</td>
              <td className="p-3 text-center">{rpa.DOC_IDENTIDADE_VERSO ? <a href={rpa.DOC_IDENTIDADE_VERSO} target="_blank" rel="noreferrer" className="text-blue-500">Link</a> : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const renderDebugZapi = () => (
    <div className="overflow-x-auto pb-4">
      <table className="w-full text-left whitespace-nowrap mt-4">
        <thead>
          <tr className="bg-slate-100 border-b border-slate-200 text-[10px] font-black uppercase tracking-wider text-slate-600">
            <th className="p-3 w-48">DATA</th>
            <th className="p-3">LOG DA OPERAÇÃO</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {debugZapi.length === 0 && <tr><td colSpan="2" className="p-12 text-center text-slate-400">Nenhum log registado.</td></tr>}
          {debugZapi.map((log) => (
            <tr key={log.id} className="hover:bg-slate-50 text-[11px] text-slate-700 font-mono">
              <td className="p-3">{formatDate(log.DATA)}</td>
              <td className="p-3 whitespace-normal break-all">{log.LOG || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-100 p-4 font-sans text-slate-800">
      <header className="max-w-[1800px] mx-auto mb-4 flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-5 rounded-xl shadow-sm border border-slate-200">
        <div className="flex items-center gap-4">
          <div className="bg-emerald-600 p-3 rounded-xl shadow-lg shadow-emerald-200">
            <Database className="text-white w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tight text-slate-900">
              Cloud Database <span className="text-emerald-600">iGreen AutoFlow</span>
            </h1>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center mt-1">
              <Wifi className="w-3 h-3 text-emerald-500 mr-2 animate-pulse" />
              Sincronização Ativa | Dados Reais do Banco
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
            <input type="text" placeholder="Buscar por Nome ou UC..." className="pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs w-64 focus:outline-none focus:ring-2 focus:ring-emerald-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          <button className="flex items-center gap-2 bg-slate-800 text-white px-4 py-2 rounded-lg text-xs font-bold hover:bg-slate-700 transition-colors">
            <Download className="w-4 h-4" /> Exportar Planilha
          </button>
        </div>
      </header>

      <div className="max-w-[1800px] mx-auto mb-4 flex gap-2 overflow-x-auto pb-2">
        <button onClick={() => setActiveTab('AUDITORIA_IGREEN')} className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all whitespace-nowrap ${activeTab === 'AUDITORIA_IGREEN' ? 'bg-emerald-600 text-white shadow-md' : 'bg-white text-slate-500 hover:bg-slate-50 border border-slate-200'}`}><Leaf className="w-4 h-4" /> AUDITORIA_IGREEN</button>
        <button onClick={() => setActiveTab('HISTORICO_VOZ')} className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all whitespace-nowrap ${activeTab === 'HISTORICO_VOZ' ? 'bg-blue-600 text-white shadow-md' : 'bg-white text-slate-500 hover:bg-slate-50 border border-slate-200'}`}><Mic className="w-4 h-4" /> HISTORICO_VOZ</button>
        <button onClick={() => setActiveTab('FILA_RPA_IGREEN')} className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all whitespace-nowrap ${activeTab === 'FILA_RPA_IGREEN' ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-slate-500 hover:bg-slate-50 border border-slate-200'}`}><Bot className="w-4 h-4" /> FILA_RPA_IGREEN</button>
        <button onClick={() => setActiveTab('DEBUG_ZAPI')} className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all whitespace-nowrap ${activeTab === 'DEBUG_ZAPI' ? 'bg-slate-800 text-white shadow-md' : 'bg-white text-slate-500 hover:bg-slate-50 border border-slate-200'}`}><Terminal className="w-4 h-4" /> DEBUG_ZAPI</button>
      </div>

      <main className="max-w-[1800px] mx-auto bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden min-h-[500px]">
        {activeTab === 'AUDITORIA_IGREEN' && renderAuditoria()}
        {activeTab === 'HISTORICO_VOZ' && renderHistoricoVoz()}
        {activeTab === 'FILA_RPA_IGREEN' && renderFilaRpa()}
        {activeTab === 'DEBUG_ZAPI' && renderDebugZapi()}
      </main>
    </div>
  );
}
