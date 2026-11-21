// SPDX-License-Identifier: GPL-3.0-or-later
import '@fontsource/ubuntu/latin-400.css';
import '@fontsource/ubuntu/latin-500.css';
import { render } from 'preact';
import { App } from './app.tsx';
import './ui/styles.css';

render(<App />, document.getElementById('app')!);
