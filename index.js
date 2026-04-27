import axios from 'axios';

const createGeminiDebugAxios = () => {
  const instance = axios.create({
    baseURL: 'https://generativelanguage.googleapis.com',
  });

  const maskUrl = (fullUrl) => {
    // Mask API key in URL for security
    return fullUrl.replace(/key=([A-Za-z0-9_-]{1,8})([A-Za-z0-9_-]*)/g, 'key=$1...[HIDDEN]');
  };

  // Optional: Log requests
  instance.interceptors.request.use((config) => {
    const fullUrl = config.baseURL + config.url;
    console.log(`[REQUEST] ${config.method?.toUpperCase()} ${maskUrl(fullUrl)}`);
    return config;
  });

  // Response error interceptor for debugging
  instance.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response) {
        const fullUrl = error.config.baseURL + error.config.url;
        const maskedUrl = maskUrl(fullUrl);
        const status = error.response.status;
        let prefix = '';

        if (status === 401 || status === 403) {
          prefix = '[AUTH ERROR]';
        } else if (status === 404) {
          prefix = '[ROUTE/MODEL ERROR]';
        } else {
          prefix = `[HTTP ${status} ERROR]`;
        }

        const errorData = error.response.data;
        const errorMsg = errorData?.error?.message ||
                         errorData?.message ||
                         errorData?.error?.details ||
                         JSON.stringify(errorData, null, 2);

        console.error(`${prefix} URL: ${maskedUrl}`);
        console.error(`Status: ${status}`);
        console.error('Google Error Details:');
        console.error(errorMsg);
        console.error('---');
      } else if (error.request) {
        console.error('[NETWORK ERROR] No response received:', error.message);
      } else {
        console.error('[REQUEST ERROR]', error.message);
      }
      return Promise.reject(error);
    }
  );

  return instance;
};

// Usage example:
// const geminiApi = createGeminiDebugAxios();
// geminiApi.post('/v1beta/models/gemini-1.5-pro:generateContent?key=YOUR_API_KEY', { contents: [...] })
//   .then(res => console.log('Success:', res.data))
//   .catch(err => console.error('Handled by interceptor'));

export default createGeminiDebugAxios;
