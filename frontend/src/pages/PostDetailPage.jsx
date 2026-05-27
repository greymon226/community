import { useEffect, useState } from 'react';
import {
  Card, Avatar, Space, Button, Tag, Divider, Input, List, Modal, App, Popconfirm, Tooltip, Drawer, Spin, Empty, Typography,
} from 'antd';
import {
  LikeOutlined, LikeFilled, StarOutlined, StarFilled, ShareAltOutlined,
  EyeOutlined, MessageOutlined, ExclamationCircleOutlined, EditOutlined, DeleteOutlined,
  PushpinOutlined, FireOutlined, StopOutlined, RobotOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { postApi, commentApi, reportApi } from '../api';
import RichContent from '../components/RichContent.jsx';
import { useAuthStore } from '../store/auth.js';

export default function PostDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { token, user } = useAuthStore();
  const { message, modal } = App.useApp();
  const [post, setPost] = useState(null);
  const [comments, setComments] = useState([]);
  const [content, setContent] = useState('');
  const [replyTo, setReplyTo] = useState(null);

  // AI 解读
  const [aiOpen, setAiOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null);

  const loadExplain = async (force = false) => {
    setAiLoading(true);
    try {
      // 通过 axios 拦截器：失败会全局 toast。这里只处理成功路径
      const r = await postApi.explain(id);
      setAiResult(r);
    } catch (e) {
      // 错误已被全局拦截器 toast；保留旧结果或清空
      if (force) setAiResult(null);
    } finally {
      setAiLoading(false);
    }
  };

  const openAiDrawer = () => {
    setAiOpen(true);
    if (!aiResult) loadExplain();
  };

  const load = () => {
    postApi.detail(id).then(setPost);
    commentApi.list(id).then(setComments);
  };
  useEffect(() => { load(); }, [id]);

  if (!post) return <Card loading />;

  const isAuthor = user?.id === post.authorId;
  const isAdmin = user?.role === 'admin';
  const isModerator = user?.role === 'moderator';

  const toggleLike = async () => {
    if (!token) return nav('/login');
    const r = await postApi.like(post.id);
    setPost({ ...post, ...r });
  };
  const toggleFavorite = async () => {
    if (!token) return nav('/login');
    const r = await postApi.favorite(post.id);
    setPost({ ...post, ...r });
  };
  const sharePost = () => {
    const url = `${location.origin}/post/${post.id}`;
    navigator.clipboard?.writeText(url);
    message.success('链接已复制，可粘贴到企业微信/钉钉');
  };
  const submitComment = async () => {
    if (!content.trim()) return;
    try {
      const r = await commentApi.create(post.id, { content, replyToId: replyTo?.id || null });
      setContent('');
      setReplyTo(null);
      if (r?.pending) {
        message.warning('已提交，AI 审核存疑，等待管理员复审');
      } else {
        message.success('已发布');
      }
      load();
    } catch (e) {
      // 错误已由 axios 拦截器统一提示，避免再次 toast
    }
  };
  const reportPost = () => {
    let reason = '';
    modal.confirm({
      title: '举报帖子',
      icon: <ExclamationCircleOutlined />,
      content: <Input.TextArea rows={3} placeholder="请描述违规原因" onChange={(e) => (reason = e.target.value)} />,
      onOk: async () => {
        if (!reason.trim()) { message.warning('请填写理由'); return Promise.reject(); }
        await reportApi.create({ targetType: 'post', targetId: post.id, reason });
        message.success('举报已提交');
      },
    });
  };
  const removePost = async () => {
    await postApi.remove(post.id);
    message.success('已删除');
    nav('/');
  };
  const togglePin = async () => {
    const r = await postApi.pin(post.id, post.pinned > 0 ? 0 : 1);
    setPost({ ...post, ...r });
  };
  const toggleFeature = async () => {
    const r = await postApi.feature(post.id);
    setPost({ ...post, ...r });
  };
  const toggleBlock = async () => {
    const r = await postApi.block(post.id);
    setPost({ ...post, ...r });
  };

  const removeComment = async (cid) => {
    await commentApi.remove(cid);
    message.success('已删除');
    load();
  };
  const likeComment = async (c) => {
    if (!token) return nav('/login');
    const r = await commentApi.like(c.id);
    setComments(comments.map((x) => (x.id === c.id ? { ...x, ...r } : x)));
  };

  return (
    <>
      <Card>
        <Space style={{ marginBottom: 8 }}>
          {post.pinned > 0 && <Tag color="orange">{post.pinned === 2 ? '全站置顶' : '置顶'}</Tag>}
          {post.featured && <Tag color="magenta">精华</Tag>}
          {post.status === 'blocked' && <Tag color="red">已屏蔽</Tag>}
          {post.aiAuditStatus === 'review' && <Tag color="gold">AI 审核中</Tag>}
          {post.aiAuditStatus === 'skipped' && <Tag>AI 审核未启用</Tag>}
        </Space>
        <h1 style={{ marginTop: 0 }}>{post.title}</h1>
        <Space size="middle" style={{ color: '#8c8c8c', marginBottom: 16 }}>
          <Avatar src={post.author?.avatar}>{post.author?.name?.[0]}</Avatar>
          <span>{post.author?.nickname || post.author?.name}</span>
          <span>{post.author?.department}</span>
          <span>{dayjs(post.createdAt).format('YYYY-MM-DD HH:mm')}</span>
          <Tag onClick={() => nav(`/?categoryId=${post.categoryId}`)} style={{ cursor: 'pointer' }}>
            {post.category?.name}
          </Tag>
          {post.tags?.map((t) => <Tag key={t.id}>{t.name}</Tag>)}
        </Space>
        <Divider />
        <RichContent html={post.content} />
        <Divider />
        <Space size="large" wrap>
          <Button icon={post.liked ? <LikeFilled /> : <LikeOutlined />} type={post.liked ? 'primary' : 'default'} onClick={toggleLike}>
            {post.likeCount}
          </Button>
          <Button icon={post.favorited ? <StarFilled /> : <StarOutlined />} onClick={toggleFavorite}>
            收藏 {post.favoriteCount}
          </Button>
          <Button icon={<ShareAltOutlined />} onClick={sharePost}>分享</Button>
          <Button icon={<RobotOutlined />} onClick={openAiDrawer}>AI 解读</Button>
          <Tooltip title="浏览量"><span><EyeOutlined /> {post.viewCount}</span></Tooltip>
          <Tooltip title="评论数"><span><MessageOutlined /> {post.commentCount}</span></Tooltip>
          {token && !isAuthor && <Button danger onClick={reportPost}>举报</Button>}
          {(isAuthor || isAdmin) && (
            <>
              <Button icon={<EditOutlined />} onClick={() => nav(`/post/edit/${post.id}`)}>编辑</Button>
              <Popconfirm title="确认删除？" onConfirm={removePost}>
                <Button icon={<DeleteOutlined />} danger>删除</Button>
              </Popconfirm>
            </>
          )}
          {(isAdmin || isModerator) && (
            <>
              <Button icon={<PushpinOutlined />} onClick={togglePin}>{post.pinned > 0 ? '取消置顶' : '置顶'}</Button>
              <Button icon={<FireOutlined />} onClick={toggleFeature}>{post.featured ? '取消精华' : '加精'}</Button>
              <Button icon={<StopOutlined />} onClick={toggleBlock}>{post.status === 'blocked' ? '解除屏蔽' : '屏蔽'}</Button>
            </>
          )}
        </Space>
      </Card>

      <Card title={`评论 (${comments.length})`} style={{ marginTop: 12 }}>
        {token ? (
          <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
            <Input.TextArea
              rows={3}
              value={content}
              placeholder={replyTo ? `回复 @${replyTo.author?.nickname || replyTo.author?.name}` : '说点什么...'}
              onChange={(e) => setContent(e.target.value)}
            />
            <Button type="primary" onClick={submitComment} style={{ height: 'auto' }}>发布</Button>
            {replyTo && <Button onClick={() => setReplyTo(null)}>取消引用</Button>}
          </Space.Compact>
        ) : (
          <Button onClick={() => nav('/login')}>登录后参与评论</Button>
        )}
        <List
          dataSource={comments}
          locale={{ emptyText: '暂无评论' }}
          renderItem={(c) => (
            <List.Item
              actions={[
                <Button type="text" size="small" icon={<LikeOutlined />} onClick={() => likeComment(c)}>
                  {c.likeCount}
                </Button>,
                <Button type="link" size="small" onClick={() => setReplyTo(c)}>回复</Button>,
                (c.authorId === user?.id || isAdmin || isModerator) && (
                  <Popconfirm title="删除评论？" onConfirm={() => removeComment(c.id)}>
                    <Button type="link" size="small" danger>删除</Button>
                  </Popconfirm>
                ),
              ].filter(Boolean)}
            >
              <List.Item.Meta
                avatar={<Avatar src={c.author?.avatar}>{c.author?.name?.[0]}</Avatar>}
                title={
                  <Space>
                    <span>{c.author?.nickname || c.author?.name}</span>
                    <span style={{ color: '#8c8c8c', fontSize: 12 }}>{dayjs(c.createdAt).format('MM-DD HH:mm')}</span>
                  </Space>
                }
                description={
                  <>
                    {c.replyTo && (
                      <div style={{ background: '#f5f5f5', padding: 8, borderRadius: 4, marginBottom: 6 }}>
                        @{c.replyTo.author?.nickname || c.replyTo.author?.name}：
                        <span dangerouslySetInnerHTML={{ __html: c.replyTo.content }} />
                      </div>
                    )}
                    <RichContent html={c.content} />
                  </>
                }
              />
            </List.Item>
          )}
        />
      </Card>

      <Drawer
        title={<Space><RobotOutlined /> AI 解读</Space>}
        width={520}
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={aiLoading}
            onClick={() => loadExplain(true)}
          >
            重新生成
          </Button>
        }
      >
        {aiLoading && !aiResult ? (
          <div style={{ textAlign: 'center', padding: 80 }}>
            <Spin tip="AI 正在阅读这篇帖子..." />
          </div>
        ) : aiResult ? (
          <div>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              由 {aiResult.model} 生成 · 用时 {aiResult.elapsedMs}ms
              {aiResult.cached ? ' · 命中缓存' : ''}
              {typeof aiResult.quotaUsed === 'number'
                ? ` · 今日已用 ${aiResult.quotaUsed}/${aiResult.quotaLimit}`
                : ''}
              。AI 内容仅供参考，请结合原文核对。
            </Typography.Paragraph>

            <Typography.Title level={5}>核心摘要</Typography.Title>
            <Typography.Paragraph>{aiResult.summary || '—'}</Typography.Paragraph>

            <Typography.Title level={5}>关键要点</Typography.Title>
            {aiResult.keyPoints?.length ? (
              <ul style={{ paddingLeft: 20 }}>
                {aiResult.keyPoints.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无" />}

            <Typography.Title level={5}>建议与改进</Typography.Title>
            {aiResult.suggestions?.length ? (
              <ul style={{ paddingLeft: 20 }}>
                {aiResult.suggestions.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无" />}

            <Typography.Title level={5}>可延伸思考</Typography.Title>
            {aiResult.questions?.length ? (
              <ul style={{ paddingLeft: 20 }}>
                {aiResult.questions.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无" />}
          </div>
        ) : (
          <Empty description="暂无解读" />
        )}
      </Drawer>
    </>
  );
}
