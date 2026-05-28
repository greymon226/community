import { useEffect, useRef } from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';

[
  ['bash', bash],
  ['css', css],
  ['java', java],
  ['javascript', javascript],
  ['js', javascript],
  ['json', json],
  ['python', python],
  ['py', python],
  ['sql', sql],
  ['typescript', typescript],
  ['ts', typescript],
  ['xml', xml],
  ['html', xml],
].forEach(([name, language]) => {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language);
});

export default function RichContent({ html }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.querySelectorAll('pre code').forEach((el) => {
      try { hljs.highlightElement(el); } catch (e) { /* ignore */ }
    });
    ref.current.querySelectorAll('img').forEach((img) => {
      img.setAttribute('loading', 'lazy');
    });
  }, [html]);
  return <div ref={ref} className="rich-content" dangerouslySetInnerHTML={{ __html: html || '' }} />;
}
