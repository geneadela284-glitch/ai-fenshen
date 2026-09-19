import { Component } from 'react';
export default class GameBoundary extends Component {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div role="alert" style={{position:'fixed',inset:0,zIndex:100,display:'grid',placeContent:'center',gap:20,padding:30,background:'#10291f',color:'#f0dfb6'}}><strong>游戏暂时没有加载成功</strong><span>已保存的牌局会保留，请重新加载后继续。</span><button onClick={()=>window.location.reload()} style={{padding:16,color:'#182c21',background:'#e2c282',borderRadius:8}}>重新加载</button><button onClick={this.props.onBack} style={{padding:16,color:'#ead6a7',background:'#264d3a',borderRadius:8}}>返回首页</button></div>:this.props.children;}
}
