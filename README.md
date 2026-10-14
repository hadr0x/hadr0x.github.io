# Analisi Flare – versione web

Pagina statica che esegue `flare.py` direttamente nel browser (con [Pyodide](https://pyodide.org)).
Si carica uno o più file del FlySight e si vedono riepilogo, grafici di ogni flare e confronto tra i voli.
I file non vengono caricati su nessun server.

## File

| file | cosa fa |
|---|---|
| `index.html` | la pagina |
| `style.css` | grafica (chiaro/scuro automatico) |
| `app.js` | carica Python, legge i file, disegna tabelle e grafici |
| `flare.py` | **copia** dello script di analisi nella cartella principale |

> Se modifichi `../flare.py`, ricopialo qui prima di pubblicare:
>
> ```bash
> cp ../flare.py flare.py
> ```

## Provarla sul computer

Va aperta tramite un piccolo server (aprendo `index.html` con doppio clic il browser blocca il caricamento di `flare.py`):

```bash
python3 -m http.server 8000
```

poi apri <http://localhost:8000> (comando lanciato da dentro questa cartella).

## Pubblicarla su GitHub Pages

**In un repository nuovo** (es. `flare`):

1. Crea il repository su GitHub (pubblico).
2. Carica il contenuto di questa cartella `web/` nella radice del repository
   (dalla pagina del repository: *Add file → Upload files*, trascina i 5 file, *Commit*).
3. *Settings → Pages → Build and deployment*: Source **Deploy from a branch**, Branch **main**, cartella **/ (root)**, *Save*.
4. Dopo un minuto è online su `https://<tuonome>.github.io/flare/`.

**Nel repository del tuo sito** (`<tuonome>.github.io`): copia questa cartella dentro il repository
con il nome che vuoi (es. `flare/`) e fai commit: sarà su `https://<tuonome>.github.io/flare/`.

Non servono build, né chiavi, né server: tutto gratuito con un repository pubblico.
