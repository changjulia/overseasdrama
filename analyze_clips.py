import cv2
from pathlib import Path
import math

VIDEOS = [Path(r"Y:\片头库\片头-1.mp4"), Path(r"Y:\片头库\片头-2.mp4"), Path(r"Y:\片头库\片头-3.mp4")]
OUT = Path("outputs/clip_analysis")
OUT.mkdir(parents=True, exist_ok=True)

def frame_at(cap, sec):
    cap.set(cv2.CAP_PROP_POS_MSEC, sec * 1000)
    ok, frame = cap.read()
    if not ok:
        return None
    return frame

def sheet(cap, times, target, cols=4):
    thumbs=[]
    for t in times:
        f=frame_at(cap,t)
        if f is None: continue
        h,w=f.shape[:2]
        tw=320; th=round(h*tw/w)
        f=cv2.resize(f,(tw,th))
        cv2.rectangle(f,(0,0),(135,30),(0,0,0),-1)
        cv2.putText(f,f"{t:.1f}s",(8,22),cv2.FONT_HERSHEY_SIMPLEX,.65,(255,255,255),2,cv2.LINE_AA)
        thumbs.append(f)
    if not thumbs: return
    th,tw=thumbs[0].shape[:2]
    rows=math.ceil(len(thumbs)/cols)
    canvas=255*__import__('numpy').ones((rows*th,cols*tw,3),dtype='uint8')
    for i,f in enumerate(thumbs):
        y=(i//cols)*th; x=(i%cols)*tw
        canvas[y:y+th,x:x+tw]=f
    cv2.imwrite(str(target),canvas)

for idx,p in enumerate(VIDEOS,1):
    cap=cv2.VideoCapture(str(p))
    fps=cap.get(cv2.CAP_PROP_FPS); frames=cap.get(cv2.CAP_PROP_FRAME_COUNT)
    dur=frames/fps if fps else 0
    w=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); h=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"{p.name}\tduration={dur:.3f}\tresolution={w}x{h}\tfps={fps:.3f}\tframes={int(frames)}")
    sheet(cap,[x*.5 for x in range(min(25,int(dur*2)+1))],OUT/f"clip-{idx}-first12.jpg",4)
    step=max(3.0,dur/24)
    sheet(cap,[min(dur-.05,x*step) for x in range(math.ceil(dur/step))],OUT/f"clip-{idx}-overview.jpg",4)
    cap.release()
