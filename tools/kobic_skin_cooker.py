"""Strict glTF -> Kobic FRSK v1 offline skin cooker (requires NumPy).

Supported: one indexed TRIANGLES primitive, one skin, ordered joints whose
ancestors belong to the skin, identity mesh node, external buffer, four weights.
No silent static baking of unsupported animation/morph/scene layouts.
"""
from pathlib import Path
import argparse,json,struct
import numpy as np

def cook(source, target):
    doc=json.loads(source.read_text())
    def require(ok,message):
        if not ok: raise ValueError(message)
    require(doc.get('asset',{}).get('version')=='2.0','requires glTF 2.0')
    require(len(doc['buffers'])==1 and len(doc['meshes'])==1 and len(doc['skins'])==1,'requires one buffer, mesh, skin')
    uri=doc['buffers'][0]['uri']
    require(not uri.startswith('data:') and not Path(uri).is_absolute(),'requires relative external buffer')
    blob=(source.parent/uri).read_bytes()
    require(len(blob)>=doc['buffers'][0]['byteLength'],'truncated buffer')
    require(not doc.get('animations'),'animation clips are not supported by this cooker')
    types={5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1'}
    dims={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
    def read(index):
        a=doc['accessors'][index];v=doc['bufferViews'][a['bufferView']]
        require('sparse' not in a and a['componentType'] in types,'unsupported accessor')
        dt=np.dtype(types[a['componentType']]);dim=dims[a['type']]
        require(v.get('buffer',0)==0 and a['count']>0,'invalid buffer/accessor count')
        view_off=v.get('byteOffset',0);local_off=a.get('byteOffset',0)
        off=view_off+local_off;stride=v.get('byteStride',dt.itemsize*dim)
        end=local_off+(a['count']-1)*stride+dt.itemsize*dim
        require(view_off>=0 and local_off>=0 and stride>=dt.itemsize*dim and end<=v['byteLength'] and view_off+v['byteLength']<=len(blob),'accessor out of range')
        arr=np.ndarray((a['count'],dim),dt,buffer=blob,offset=off,strides=(stride,dt.itemsize)).copy()
        if a.get('normalized'):
            require(dt.kind=='u','normalized unsigned components required')
            arr=arr.astype(np.float32)/np.iinfo(dt).max
        return arr
    prims=doc['meshes'][0]['primitives'];require(len(prims)==1,'one primitive per skin asset')
    p=prims[0];require(p.get('mode',4)==4 and not p.get('targets'),'requires triangles, no morphs')
    attrs=p['attributes'];pos=read(attrs['POSITION']);normal=read(attrs['NORMAL']);uv=read(attrs['TEXCOORD_0'])
    j=read(attrs['JOINTS_0']);w=read(attrs['WEIGHTS_0']);raw_ix=read(p['indices'])
    require(j.dtype.kind=='u' and raw_ix.dtype.kind=='u' and raw_ix.shape[1]==1,'unsigned joints and scalar indices required')
    ix=raw_ix.reshape(-1).astype('<u4')
    skin=doc['skins'][0];nodes=doc['nodes'];ids=skin['joints'];nj=len(ids);nv=len(pos)
    require(0<nj<=128 and 0<nv<=32768,'skin limits exceeded')
    require(pos.shape==(nv,3) and normal.shape==(nv,3) and uv.shape==(nv,2) and j.shape==w.shape==(nv,4),'attribute shape mismatch')
    require(np.all(np.isfinite(pos)) and np.all(np.isfinite(normal)) and np.all(np.isfinite(uv)) and np.all(np.isfinite(w)),'non-finite geometry/weights')
    require(np.all(j<nj) and np.all(w>=0) and np.all(w<=1) and np.allclose(w.sum(axis=1),1,atol=1e-5),'invalid joints/weights')
    require(len(ix)%3==0 and 0<len(ix)<=196608 and ix.max()<nv,'invalid indices')
    parent={}
    for i,n in enumerate(nodes):
        for child in n.get('children',[]):
            require(0<=child<len(nodes) and child not in parent,'invalid or multiply parented node')
            parent[child]=i
    lookup={node:i for i,node in enumerate(ids)}
    require(len(lookup)==nj,'duplicate joints')
    mesh_ids=[i for i,n in enumerate(nodes) if n.get('mesh')==0]
    require(len(mesh_ids)==1,'one mesh node required')
    mesh_node=nodes[mesh_ids[0]]
    require(mesh_ids[0] not in parent and mesh_node.get('skin')==0 and not any(k in mesh_node for k in ('matrix','translation','rotation','scale')),'mesh node must be root identity with skin 0')
    ib=read(skin['inverseBindMatrices']).astype('<f4')
    require(ib.shape==(nj,16) and np.all(np.isfinite(ib)),'invalid inverse binds')
    records=bytearray()
    for joint,node_id in enumerate(ids):
        require(0<=node_id<len(nodes),'joint node out of range')
        n=nodes[node_id];pn=parent.get(node_id,-1)
        require(pn==-1 or pn in lookup,'all joint ancestors must be in skin')
        pj=lookup.get(pn,-1);require(pj<joint,'joints must be topologically ordered')
        require(n.get('scale',[1,1,1])==[1,1,1],'non-rigid joint scaling unsupported')
        if 'matrix' in n: local=np.array(n['matrix'],dtype='<f4').reshape(4,4).T
        else:
            q=np.array(n.get('rotation',[0,0,0,1]),float);require(np.isclose(np.linalg.norm(q),1,atol=1e-5),'joint quaternion not normalized')
            x,y,z,a=q
            local=np.eye(4,dtype='<f4');local[:3,:3]=[[1-2*(y*y+z*z),2*(x*y-z*a),2*(x*z+y*a)],[2*(x*y+z*a),1-2*(x*x+z*z),2*(y*z-x*a)],[2*(x*z-y*a),2*(y*z+x*a),1-2*(x*x+y*y)]]
            local[:3,3]=n.get('translation',[0,0,0])
        require(np.all(np.isfinite(local)) and np.allclose(local[3],[0,0,0,1],atol=1e-5) and np.allclose(local[:3,:3].T@local[:3,:3],np.eye(3),atol=1e-4),'rigid affine local bind required')
        records.extend(struct.pack('<i12x',pj));records.extend(local.T.astype('<f4').tobytes());records.extend(ib[joint].tobytes())
    vertices=np.hstack([pos,normal,np.ones((nv,3)),uv]).astype('<f4')
    weights=np.hstack([j,w]).astype('<f4')
    vo=48;wo=vo+nv*44;io=wo+nv*32;jo=io+len(ix)*4
    header=struct.pack('<9I12x',0x4B535246,1,nv,len(ix),nj,vo,wo,io,jo)
    target.write_bytes(header+vertices.tobytes()+weights.tobytes()+ix.tobytes()+records)
    print(f'PASS skin cooked: {target.name}: {nv} vertices, {len(ix)//3} triangles, {nj} joints')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('source',type=Path);parser.add_argument('target',type=Path)
    args=parser.parse_args();cook(args.source,args.target)
