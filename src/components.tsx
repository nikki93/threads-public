import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import './styles.css';

//
// Entrypoint
//

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
