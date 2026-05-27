import { useEffect, useState, useMemo } from 'react';
import { Row, Col, Card, Tree, Select, Pagination, Empty, Tag, Space, Button, Spin } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { categoryApi, postApi } from '../api';
import { useAuthStore } from '../store/auth.js';
import AskAiDrawer from '../components/AskAiDrawer.jsx';
import dayjs from 'dayjs';

export default function HomePage() {
  const [tree, setTree] = useState([]);
  const [list, setList] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [recommend, setRecommend] = useState([]);
  const [askOpen, setAskOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { token, user } = useAuthStore();

  const sort = params.get('sort') || 'latest';
  const categoryId = params.get('categoryId') || '';
  const keyword = params.get('keyword') || '';
  const page = parseInt(params.get('page') || '1', 10);

  useEffect(() => {
    categoryApi.tree().then(setTree);
  }, []);

  useEffect(() => {
    setLoading(true);
    postApi
      .list({ sort, categoryId: categoryId || undefined, keyword: keyword || undefined, page, pageSize: 10 })
      .then(setList)
      .finally(() => setLoading(false));
  }, [sort, categoryId, keyword, page]);

  useEffect(() => {
    if (token) postApi.recommend().then(setRecommend).catch(() => {});
  }, [token]);

  const treeData = useMemo(() => {
    const toNode = (c) => ({
      key: String(c.id),
      title: c.name,
      children: (c.children || []).map(toNode),
    });
    return [{ key: '', title: '全部分类', children: tree.map(toNode) }];
  }, [tree]);

  const updateParams = (patch) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') next.delete(k);
      else next.set(k, v);
    });
    if (!('page' in patch)) next.set('page', '1');
    setParams(next);
  };

  return (
    <Row gutter={16}>
      <Col xs={0} md={6}>
        <Card title="板块" size="small" className="sidebar-card">
          <Tree
            treeData={treeData}
            defaultExpandAll
            selectedKeys={[categoryId]}
            onSelect={(keys) => updateParams({ categoryId: keys[0] || '' })}
          />
        </Card>
        {token && recommend.length > 0 && (
          <Card title="为你推荐" size="small" className="sidebar-card">
            {recommend.map((p) => (
              <div key={p.id} style={{ padding: '6px 0', cursor: 'pointer' }} onClick={() => nav(`/post/${p.id}`)}>
                <div style={{ fontSize: 13, color: '#262626' }}>{p.title}</div>
                <div style={{ fontSize: 12, color: '#8c8c8c' }}>👍 {p.likeCount} · 👁 {p.viewCount}</div>
              </div>
            ))}
          </Card>
        )}
      </Col>

      <Col xs={24} md={18}>
        <Card size="small" style={{ marginBottom: 12 }}>
          <Space wrap>
            <span>排序：</span>
            <Select
              value={sort}
              style={{ width: 130 }}
              onChange={(v) => updateParams({ sort: v })}
              options={[
                { value: 'latest', label: '最新' },
                { value: 'hot', label: '最热' },
                { value: 'comments', label: '最多评论' },
                { value: 'featured', label: '精华' },
              ]}
            />
            {keyword && <Tag closable onClose={() => updateParams({ keyword: '' })}>关键字: {keyword}</Tag>}
            {categoryId && <Tag closable onClose={() => updateParams({ categoryId: '' })}>已选分类</Tag>}
            <Button
              type="primary"
              ghost
              icon={<RobotOutlined />}
              onClick={() => setAskOpen(true)}
              disabled={!token}
              title={token ? '基于站内帖子的 AI 问答' : '登录后可使用'}
            >
              AI 问答
            </Button>
          </Space>
        </Card>

        <Spin spinning={loading}>
          {list.items.length === 0 ? (
            <Empty description="暂无帖子" />
          ) : (
            list.items.map((p) => (
              <div className="post-card" key={p.id}>
                <div className="meta">
                  <span>{p.author?.nickname || p.author?.name}</span>
                  <span> · {p.author?.department}</span>
                  <span> · {dayjs(p.createdAt).format('YYYY-MM-DD HH:mm')}</span>
                  <span> · {p.category?.name}</span>
                  {p.pinned > 0 && <Tag color="orange" style={{ marginLeft: 8 }}>{p.pinned === 2 ? '全站置顶' : '置顶'}</Tag>}
                  {p.featured && <Tag color="magenta">精华</Tag>}
                </div>
                <div className="title" onClick={() => nav(`/post/${p.id}`)}>{p.title}</div>
                <div className="summary">{p.summary}</div>
                <div className="actions">
                  <span title={`点赞数：${p.likeCount}`}>👍 {p.likeCount}</span>
                  <span title={`评论数：${p.commentCount}`}>💬 {p.commentCount}</span>
                  <span title={`收藏数：${p.favoriteCount}`}>⭐ {p.favoriteCount}</span>
                  <span title={`浏览数：${p.viewCount}`}>👁 {p.viewCount}</span>
                  {p.tags?.map((t) => <Tag key={t.id}>{t.name}</Tag>)}
                </div>
              </div>
            ))
          )}
        </Spin>

        {list.total > 0 && (
          <div style={{ textAlign: 'center', margin: 16 }}>
            <Pagination
              current={page}
              total={list.total}
              pageSize={10}
              onChange={(p) => updateParams({ page: p })}
              showSizeChanger={false}
            />
          </div>
        )}
      </Col>

      <AskAiDrawer
        open={askOpen}
        onClose={() => setAskOpen(false)}
        initialQuestion={keyword || ''}
      />
    </Row>
  );
}
