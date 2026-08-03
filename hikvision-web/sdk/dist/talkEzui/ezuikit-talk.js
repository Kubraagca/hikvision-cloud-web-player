/**
 * ezuikit-talk v0.0.1-beta
 */
(function (global, factory) {
  "use strict";

  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = global.document
      ? factory(global, true)
      : function (w) {
        if (!w.document) {
          throw new Error("EZUIPlayer requires a window with a document");
        }
        return factory(w);
      };
  } else {
    factory(global);
  }

  // Pass this if window is not defined yet
})(typeof window !== "undefined" ? window : this, function (window, noGlobal) {
  function PrefixCode(code, msg) {
    if (parseInt(code, 10) > 0) {
      var PRECODE = 102;
      var retcode = '102' + (code / Math.pow(10, 5)).toFixed(5).substr(2);
    } else if (code == -1) {
      retcode = -1;
    } else if (typeof code === 'undefined') {
      retcode = 0;
    }
    return {
      code: retcode,
      data: msg
    };
    // function PrefixInteger(num, length) {
    //   return (num/Math.pow(10,length)).toFixed(length).substr(2);
    //  }
  }
  // 加载js
  function addJs(filepath, callback) {
    var oJs = document.createElement("script");
    oJs.setAttribute("src", filepath);
    oJs.onload = callback;
    document.getElementsByTagName("head")[0].appendChild(oJs);
  }
  // 通用请求方法
  function request(url, method, params, header, success, error) {
    var _url = url;
    var http_request = new XMLHttpRequest();
    http_request.onreadystatechange = function () {
      if (http_request.readyState == 4) {
        if (http_request.status == 200) {
          var _data = JSON.parse(http_request.responseText);
          success(_data);
        }
      }
    };
    http_request.open(method, _url, true);
    // http_request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
    var data = new FormData();
    for (i in params) {
      data.append(i, params[i]);
    }
    http_request.send(data);
  }
  window.isEZUITalkReliesReady = false;
  var EZUITalk = function (params) {
    this.params = params;
    this.opt = {
      apiDomain: params.env ? params.env.domain + '/api/lapp/live/talk/url' : 'https://isgpopen.ezvizlife.com/api/lapp/live/talk/url',
      filePath: '',
      accessToken: undefined,
      deviceSerial: undefined,
      channelNo: undefined,
      talkLink: '',
      rtcUrl: '',
      ttsUrl: '',
      stream: ''
    };
    this.opt.accessToken = params.accessToken;
    this.opt.deviceSerial = params.deviceSerial;
    this.opt.channelNo = params.channelNo;
  };
  EZUITalk.prototype.init = function (onMessage, onError) {
    params = this.params;
    if (params.filePath) {
      this.opt.filePath = params.filePath;
    }
    var _this = this;
    function apiSuccess(data) {
      console.log("data", data);
      if (data.code == 200) {
        var apiResult = data.data;
        if (apiResult) {
          // 临时将https转换为websocket
          var rtcTrunk = apiResult.rtcUrl;
          if (rtcTrunk.indexOf("ws") === -1) {
            rtcTrunk = rtcTrunk.replace("https", "wss").replace("rtcgw", "rtcgw-ws");
          }
          _this.opt.rtcUrl = rtcTrunk;
          _this.opt.ttsUrl = "tts://" + apiResult.ttsUrl;
          var talk = "talk://" + _this.opt.deviceSerial + ":0:" + _this.opt.channelNo + ":cas.ys7.com:6500";
          _this.opt.talkLink = _this.opt.ttsUrl + "/" + talk;
          _this.opt.stream = apiResult.stream;
          console.log("_this.opt", _this.opt);
          // 加载依赖
          // this.init();
          if (!window.isEZUITalkReliesReady) {
            var adapeterJS = _this.opt.filePath + '/adapeter.js';
            var janusJS = _this.opt.filePath + '/talk-rtcgw.js';
            var ttsJS = _this.opt.filePath + '/talk-tts.js';
            console.log("加载jquery.js");
            addJs(adapeterJS, function() {
              console.log("加载adapeter.js");
              addJs(janusJS, function() {
                console.log("加载janus.js");
                addJs(ttsJS, function() {
                  console.log("加载tts.js");
                  window.isEZUITalkReliesReady = true;
                  // 文件加载完毕;
                  if (typeof onMessage === 'function') {
                    onMessage({
                      code: 10200001,
                      data: "插件加载成功"
                    });
                  }
                });
              });
            });
          } else {
            if (typeof onMessage === 'function') {
              onMessage({
                code: 10200001,
                data: "插件加载成功"
              });
            }
          }
        } else {
          if (typeof onError === 'function') {
            onError(PrefixCode(data.code, data));
          }
        }
      } else {
        if (typeof onError === 'function') {
          onError(PrefixCode(data.code, data));
        }
      }
    }
    function apiError(err) {
      if (onError) {
        onError(err);
      }
    }
    request(
      this.opt.apiDomain,
      'POST',
      {
        accessToken: this.opt.accessToken,
        deviceSerial: this.opt.deviceSerial,
        channelNo: this.opt.channelNo
      },
      '',
      apiSuccess,
      apiError
    );
    console.log("this.opt", this.opt);
  };

  // this.prototype.init = function(){
  //   var adapeterJS =  this.opt.filepath +  '/js/adapeter.js';
  //   addJs(adapeterJS,function(){
  //     console.log("加载adapeter.js")
  //   })
  // }
  EZUITalk.prototype.startTalk = function(onMessage, onError) {
    var _this = this;
    var apiSuccess = function(data) {
      if (data.code == 200) {
        var apiResult = data.data;
        if (apiResult) {
          // 临时将https转换为websocket
          _this.opt.stream = apiResult.stream;
          window.EZUITalk.opt = _this.opt;
          window.EZUITalk.params = {
            onMessage: onMessage,
            onError: onError
          };
          window.startTalk();
        }
      }
    };
    var apiError = function() {
      //layer.msg("获取对讲token失败")
      onError();
    };
    request(_this.opt.apiDomain, 'POST', {
      accessToken: _this.opt.accessToken,
      deviceSerial: _this.opt.deviceSerial,
      channelNo: _this.opt.channelNo
    }, '', apiSuccess, apiError);
  };
  EZUITalk.prototype.stopTalk = function() {
    window.stopTalk();
  };
  if (!noGlobal) {
    window.EZUITalk = EZUITalk;
  }
  return EZUITalk;
});