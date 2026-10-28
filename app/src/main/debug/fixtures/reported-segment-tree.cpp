#include<bits/stdc++.h>
using namespace std;
#define ll long long
#define db double
#define pii pair<int,int> 
#define mid ((l+r)>>1)
#define ls (p<<1)
#define rs ((p<<1)|1)
#define lson ls,l,mid
#define rson rs,mid+1,r
const int N=1e6+5;const ll inf=1e18;
struct subaru{
	ll tr[N<<2],tag[N<<2];
	void pushup(int p){tr[p]=max(tr[ls],tr[rs]);}
	void add(int p,ll v){tr[p]+=v,tag[p]+=v;}
	void pushdown(int p){if(tag[p]) add(ls,tag[p]),add(rs,tag[p]);}
	void update(int p,int l,int r,int x,ll v){
		if(l==r) {tr[p]=max(tr[p],v);return;}
		pushdown(p);
		x<=mid?update(lson,x,v):update(rson,x,v);pushup(p);
	}
	ll query(int p,int l,int r,int x){
		if(l==r) return tr[p];
		pushdown(p);
		return x<=mid?query(lson,x):query(rson,x);
	}
	void build(int p,int l,int r){
		tr[p]=-inf,tag[p]=0;
		if(l!=r) build(lson),build(rson);
	}
}tr1,tr0;
int T,n,m,a[N],c[N];
void solve(){
	cin>>n;m=0;for(int i=1;i<=n;i++) {cin>>a[i],c[++m]=a[i];}
	c[++m]=0;sort(c+1,c+m+1);m=unique(c+1,c+m+1)-c-1;
	for(int i=1;i<=n;i++) a[i]=lower_bound(c+1,c+m+1,a[i])-c;
	tr1.build(1,1,m),tr0.build(1,1,m);
	tr1.update(1,1,n,1,0),tr0.update(1,1,n,1,0);
	for(int i=1;i<=n;i++){
		int f1=max(tr0.tr[1],tr0.query(1,1,n,a[i])+c[a[i]]),f0=max(tr1.tr[1],tr1.query(1,1,n,a[i])+c[a[i]]);
		if(a[i]==a[i-1]) tr1.add(1,c[a[i]]),tr0.add(1,c[a[i]]);
		tr1.update(1,1,n,c[i-1],f1),tr0.update(1,1,n,c[i-1],f0);
	}
	cout<<max(tr0.tr[1],tr1.tr[1])<<"\n";
}
signed main(){
	ios::sync_with_stdio(0),cin.tie(0),cout.tie(0);
	//freopen(".in","r",stdin),freopen(".out","w",stdout);
	cin>>T;while(T--) solve();
	return 0;
}

