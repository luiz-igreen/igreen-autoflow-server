# Usar a imagem oficial do Node.js leve e segura
FROM node:18-bullseye-slim

# Instalar o Chromium e as dependências do sistema operativo
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Definir as variáveis de ambiente para o Puppeteer encontrar o Chrome no Docker
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Criar a pasta da aplicação dentro do contentor
WORKDIR /usr/src/app

# Copiar os ficheiros de dependências
COPY package*.json ./

# Instalar as dependências do Node (sem tentar baixar o Chrome)
RUN npm install

# Copiar todo o resto do código da aplicação
COPY . .

# Expor a porta 10000 para a internet
EXPOSE 10000

# Comando oficial para iniciar o servidor
CMD ["npm", "start"]
