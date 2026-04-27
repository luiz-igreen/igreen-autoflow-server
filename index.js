import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, onSnapshot } from 'firebase/firestore';
import { Search, Download, Database, Leaf, Mic, Terminal, Bot, Zap, AlertTriangle, CheckCircle2 } from 'lucide-react';

const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
  apiKey: "mock", authDomain: "mock", projectId: "mock"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'igreen-autoflow-v4';

export default function DashboardPlanilha() {
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState('AUDITORIA_IGREEN');
  const [searchTerm, setSearchTerm] = useState("");
  
  const [leads, setLeads] = useState([]); 
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
              <tr><td colSpan="35" className="p-8 text-center text-slate-400">Nenhuma fatura encontrada.</td></tr>
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
                  {lead.LINK_FATURA ? <a href={lead.LINK_FATURA} target="_blank" rel="noreferrer" className="text-blue-500 hover:text-blue-700 font-bold">Fatura</a> : "-"}
                </td>
                <td className="p-3 text-center">
                  {lead.LINK_DOC_FRENTE ? <a href={lead.LINK_DOC_FRENTE} target="_blank" rel="noreferrer" className="text-blue-500 hover:text-blue-700 font-bold">Frente RG</a> : "-"}
                </td>
                <td className="p-3 text-center">
                  {lead.LINK_DOC_VERSO ? <a href={lead.LINK_DOC_VERSO} target="_blank" rel="noreferrer" className="text-blue-500 hover:text-blue-700 font-bold">Verso RG</a> : "-"}
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
              <span className="w-2 h-2 bg-amber-500 rounded-full mr-2"></span>
              Modo Demonstração Visual (Status Finalizado)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
            <input type="text" placeholder="Buscar..." className="pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs w-64" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          <button className="flex items-center gap-2 bg-slate-800 text-white px-4 py-2 rounded-lg text-xs font-bold">
            <Download className="w-4 h-4" /> Exportar
          </button>
        </div>
      </header>

      <div className="max-w-[1800px] mx-auto mb-4 flex gap-2 overflow-x-auto pb-2">
        <button onClick={() => setActiveTab('AUDITORIA_IGREEN')} className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all whitespace-nowrap ${activeTab === 'AUDITORIA_IGREEN' ? 'bg-emerald-600 text-white shadow-md' : 'bg-white text-slate-500'}`}><Leaf className="w-4 h-4" /> AUDITORIA_IGREEN</button>
        <button onClick={() => setActiveTab('DEBUG_ZAPI')} className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all whitespace-nowrap ${activeTab === 'DEBUG_ZAPI' ? 'bg-slate-800 text-white shadow-md' : 'bg-white text-slate-500'}`}><Terminal className="w-4 h-4" /> DEBUG_ZAPI</button>
      </div>

      <main className="max-w-[1800px] mx-auto bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden min-h-[500px]">
        {activeTab === 'AUDITORIA_IGREEN' && renderAuditoria()}
        {activeTab === 'DEBUG_ZAPI' && (
          <div className="p-6">
            <h3 className="font-bold text-slate-700 mb-4">Logs Recentes do Servidor:</h3>
            {debugZapi.map(log => <p key={log.id} className="font-mono text-xs text-slate-500 mb-2 border-l-2 border-emerald-500 pl-3">{log.LOG}</p>)}
          </div>
        )}
      </main>
    </div>
  );
}
