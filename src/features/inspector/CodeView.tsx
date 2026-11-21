import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { IconButton } from '../../components/Icon';
import { store } from '../../editor/store';

interface Props {
  code: string;
  /** what the code is for, in the header */
  label: string;
}

const KEYWORDS = /^(void|true|false|return|if|else|for|while|const|auto|int|double|bool)$/;

/** Light C++ coloring: comments, keywords, numbers, function names. */
function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const comment = line.indexOf('//');
  const code = comment >= 0 ? line.slice(0, comment) : line;
  const re = /([A-Za-z_][\w:]*)(\s*\()?|(-?\d+(?:\.\d+)?)|([^A-Za-z_\d]+)/g;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(code))) {
    if (m[1]) {
      const word = m[1];
      const cls = KEYWORDS.test(word) ? 'tok-kw' : m[2] ? 'tok-fn' : word.includes('::') ? 'tok-ns' : word === 'chassis' ? 'tok-obj' : '';
      out.push(<span key={k++} className={cls}>{word}</span>);
      if (m[2]) out.push(m[2]);
    } else if (m[3]) {
      out.push(<span key={k++} className="tok-num">{m[3]}</span>);
    } else {
      out.push(m[4]);
    }
  }
  if (comment >= 0) out.push(<span key={k++} className="tok-comment">{line.slice(comment)}</span>);
  return out;
}

/** The auton's (or path's) LemLib code, ready to copy into the robot project. */
export function CodeView({ code, label }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await store.copy(code);
      setCopied(true);
    } catch (e) {
      alert(`Couldn't copy: ${(e as Error).message}`);
    }
  };

  return (
    <div className="code-view">
      <div className="section-head">
        <span className="ellipsis">Output code <b className="count">{label}</b></span>
        <IconButton icon={copied ? 'check' : 'copy'} title={copied ? 'Copied' : 'Copy code'} active={copied} onClick={copy} />
      </div>
      <pre className="code scroll" tabIndex={0}>
        {code.split('\n').map((line, i) => (
          <Fragment key={i}>{highlight(line)}{'\n'}</Fragment>
        ))}
      </pre>
    </div>
  );
}
