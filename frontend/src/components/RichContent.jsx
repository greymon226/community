import { useEffect, useRef } from 'react';
import hljs from 'highlight.js';

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
