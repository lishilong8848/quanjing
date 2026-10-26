import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import NantongBaseHomePage from '../../../client/src/pages/NantongBaseHome';
import { NantongAssistant } from '../../../client/src/components/NantongAssistant';
import { PortalImage } from '../../../client/src/pages/NantongBaseHome/PortalImage';
import '../../../client/src/index.css';

const query = new URLSearchParams(window.location.search);
function ImageProbe() {
  const [src, setSrc] = useState('/probe.webp');
  return <div className="nantong-portal" style={{position:'relative',width:'600px',height:'400px'}}>
    <PortalImage src={src} alt="图片异常验证" />
    <button onClick={() => setSrc('/probe-new.webp')}>切换新图</button>
  </div>;
}
createRoot(document.getElementById('root')!).render(query.has('request-test') ?
  <ImageProbe /> : <>
    <NantongBaseHomePage />
    <NantongAssistant contextLabel="游客" conversationKey="portal-image-preview" />
  </>);
