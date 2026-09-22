import json

from mystery_video.kaggle_submit import KaggleClient


class FakeResponse:
    def __init__(self,payload):
        self.payload=payload
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def read(self): return json.dumps(self.payload).encode()


def test_bot2_kaggle_submit_uses_kernel_data_sources(monkeypatch):
    captured={}
    def fake(request,timeout):
        captured["payload"]=json.loads(request.data.decode())
        return FakeResponse({"versionNumber":4})
    monkeypatch.setattr("mystery_video.kaggle_submit.urlopen",fake)
    client=KaggleClient("token","duykhanhta")
    sub=client.submit_script(
        slug="gpu-job",title="GPU",source="print('ok')",
        enable_gpu=True,kernel_data_sources=["duykhanhta/source-job"]
    )
    assert sub.ref=="duykhanhta/gpu-job"
    assert captured["payload"]["enableGpu"] is True
    assert captured["payload"]["kernelDataSources"]==["duykhanhta/source-job"]


def test_bot2_kaggle_cpu_submission_has_no_kernel_source(monkeypatch):
    captured={}
    def fake(request,timeout):
        captured["payload"]=json.loads(request.data.decode())
        return FakeResponse({"versionNumber":1})
    monkeypatch.setattr("mystery_video.kaggle_submit.urlopen",fake)
    client=KaggleClient("token","duykhanhta")
    client.submit_script(slug="source-job",title="CPU",source="print('ok')",enable_gpu=False)
    assert captured["payload"]["enableGpu"] is False
    assert "kernelDataSources" not in captured["payload"]
