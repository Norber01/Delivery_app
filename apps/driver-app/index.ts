import { registerRootComponent } from 'expo';
// Registers the background location task before the app renders (also runs headless).
import './src/services/location';
import App from './App';

registerRootComponent(App);
