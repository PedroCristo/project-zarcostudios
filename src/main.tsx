import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.tsx';
import './index.css';
import './responsive.css';
import './i18n';

import { ScrollToTop } from "./components/ui/ScrollToTop.tsx";


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
        <ScrollToTop />
      <App />
    </BrowserRouter>
  </StrictMode>
);
