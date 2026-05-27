import { useEffect, useRef } from 'react';
import { Button, Space, Upload, App } from 'antd';
import {
  BoldOutlined, ItalicOutlined, OrderedListOutlined,
  UnorderedListOutlined, CodeOutlined, LinkOutlined,
  PictureOutlined, FontColorsOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../store/auth.js';
import { uploadApi } from '../api';

// 轻量富文本编辑器：基于 contentEditable + execCommand
// 关键点：避免在用户输入过程中通过 React 重写 DOM，否则会打断中文输入法的 composition。
//   - 仅在挂载或 value 由外部强制变更时才同步 innerHTML
//   - 通过 isComposing 标记跳过中文输入过程中的 onChange
export default function RichEditor({ value, onChange, placeholder = '请输入正文...' }) {
  const ref = useRef(null);
  const lastValueRef = useRef(value || '');
  const isComposingRef = useRef(false);
  const { message } = App.useApp();
  const { token } = useAuthStore();

  // 仅在挂载或 value 由外部修改（如编辑帖子加载到回显数据）时同步 DOM
  useEffect(() => {
    if (!ref.current) return;
    const incoming = value || '';
    if (incoming !== lastValueRef.current && incoming !== ref.current.innerHTML) {
      ref.current.innerHTML = incoming;
      lastValueRef.current = incoming;
    }
  }, [value]);

  const emit = () => {
    if (!ref.current) return;
    const html = ref.current.innerHTML;
    lastValueRef.current = html; // 记录我们触发的值，避免下一次 useEffect 反向覆盖光标
    onChange?.(html);
  };

  const exec = (cmd, val = null) => {
    if (!ref.current) return;
    ref.current.focus();
    document.execCommand(cmd, false, val);
    emit();
  };

  const insertHtml = (html) => {
    if (!ref.current) return;
    ref.current.focus();
    document.execCommand('insertHTML', false, html);
    emit();
  };

  const handleLink = () => {
    const url = prompt('请输入链接 URL');
    if (url) exec('createLink', url);
  };

  const handleCode = () => {
    insertHtml('<pre><code class="language-js">// 代码片段\n</code></pre><p></p>');
  };

  const handleTable = () => {
    insertHtml(
      '<table><thead><tr><th>列1</th><th>列2</th></tr></thead><tbody><tr><td></td><td></td></tr></tbody></table><p></p>'
    );
  };

  return (
    <div style={{ border: '1px solid #d9d9d9', borderRadius: 6 }}>
      <Space style={{ padding: 8, borderBottom: '1px solid #f0f0f0' }} wrap>
        <Button size="small" icon={<BoldOutlined />} onClick={() => exec('bold')} />
        <Button size="small" icon={<ItalicOutlined />} onClick={() => exec('italic')} />
        <Button size="small" icon={<FontColorsOutlined />} onClick={() => exec('formatBlock', 'h3')}>H3</Button>
        <Button size="small" icon={<UnorderedListOutlined />} onClick={() => exec('insertUnorderedList')} />
        <Button size="small" icon={<OrderedListOutlined />} onClick={() => exec('insertOrderedList')} />
        <Button size="small" icon={<LinkOutlined />} onClick={handleLink} />
        <Button size="small" icon={<CodeOutlined />} onClick={handleCode}>代码块</Button>
        <Button size="small" onClick={handleTable}>表格</Button>
        <Upload
          showUploadList={false}
          accept="image/*"
          action={uploadApi.url}
          headers={{ Authorization: `Bearer ${token}` }}
          onChange={({ file }) => {
            if (file.status === 'done') {
              const url = file.response?.data?.url;
              if (url) insertHtml(`<img src="${url}" alt="img" />`);
            } else if (file.status === 'error') {
              message.error('图片上传失败');
            }
          }}
        >
          <Button size="small" icon={<PictureOutlined />}>图片</Button>
        </Upload>
      </Space>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={() => { if (!isComposingRef.current) emit(); }}
        onCompositionStart={() => { isComposingRef.current = true; }}
        onCompositionEnd={() => {
          isComposingRef.current = false;
          emit();
        }}
        onBlur={emit}
        data-placeholder={placeholder}
        style={{ minHeight: 320, padding: 12, outline: 'none' }}
      />
    </div>
  );
}
