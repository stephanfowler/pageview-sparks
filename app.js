"use strict";

var defaults = {              // Examples:
        page:        '',      // '/uk-news/2014/jan/02/uk-braced-further-floods-storms-atlantic'
        graphs:      'total', // 'other:d61d00,google:89A54E,guardian:4572A7',
        markers:     '',      // 'markers=1388680400:ff9900,1388681200:ff0000'
        width:       50,
        height:      20,
        hotLevel:    50,
        hotPeriod:   5,
        alpha:       0.7,
        smoothing:   5,
        showStats:   0,       // 1, to enable
        showHours:   0        // 1, to enable
    },

    Canvas = require('canvas'),
    http = require('http'),
    url = require('url'),
    _ = require('lodash');

function resample(arr, newLen) {
    var arrLen = arr.length,
        span;
       
    if (arrLen <= newLen) { return arr; }
   
    span = arrLen / newLen;

    return _.map(_.range(0, arrLen - 1, span), function(left){
        var right = left + span,
            lf = Math.floor(left),
            lc = Math.ceil(left),
            rf = Math.floor(right),
            rc = Math.min(Math.ceil(right), arrLen - 1);

        return (
            _.reduce(_.range(lc, rf), function(sum, i) { return sum + arr[i]; }, 0) +
            arr[lf] * (lc - left) +
            arr[rc] * (right - rf)
        ) / span;
    });
}

function smooth(arr, r) {
    if (r < 2) { return arr; }
    return _.map(arr, function(x, i, arr) {
        return average(arr.slice(i, i+r));  
    });
}

function average(arr) {
    var len = arr.length;

    if (!len) { return 0; }
    if (len === 1) { return arr[0]; }
    return _.reduce(arr, function(acc, x) { return acc + x; }) / len;  
}

function numWithCommas(x) {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function eqNoCase(a, b) {
    return a.toLowerCase() === b.toLowerCase();
}

function hexToRgba(hex, alpha) {
    hex = hex.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i, function(m, r, g, b) { return r + r + g + g + b + b; });
    hex = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return 'rgba(' + (hex ? parseInt(hex[1], 16) + ',' + parseInt(hex[2], 16) + ',' + parseInt(hex[3], 16) : '0,0,0') +  ',' + alpha + ')';
}

function collateOphanData(data, opts) {
    var graphs = _.map(opts.graphs.split(','), function(graph) {
            var p = graph.split(':');
            return { name: p[0], color: (p[1] || '666666') };
        });

    if(graphs.length && data.seriesData && data.seriesData.length) {
        var graphTotal = _.find(graphs, function(g){ return eqNoCase(g.name, 'total'); }),
            graphOther = _.find(graphs, function(g){ return eqNoCase(g.name, 'other'); });
        
        _.each(data.seriesData, function(s){
            var graphThis = _.find(graphs, function(g){ return eqNoCase(g.name, s.name); }) || graphOther;

            // Drop the last data point
            s.data.pop();

            _.each(_.filter([graphThis, graphTotal], function(g) { return g; }), function(graph) {
                if (graph.data) {
                    // ...sum additinal data into the graph
                    _.each(s.data, function(d, i) {
                        graph.data[i] = graph.data[i] + d.count;
                    });
                } else {
                    graph.data = _.pluck(s.data, 'count');
                }
            });
        });

        graphs = _.filter(graphs, function(graph) { return graph.data; });

        if (!graphs.length) { return; }

        graphs = _.map(graphs, function(graph){
            var hotness = average(_.last(graph.data, opts.hotPeriod));
            graph.hotness = hotness < opts.hotLevel ? hotness < opts.hotLevel/2 ? 1 : 2 : 3;
            graph.data = smooth(resample(graph.data, opts.width), opts.smoothing);
            return graph;
        });

        return {
            seriesData: graphs,
            max: _.max(_.map(graphs, function(graph) { return _.max(graph.data); })),
            totalHits: data.totalHits,
            points: graphs[0].data.length,
            startSec: _.first(data.seriesData[0].data).dateTime/1000,
            endSec: _.last(data.seriesData[0].data).dateTime/1000
        };
    }
}

function draw(data, opts) {
    var graphHeight = opts.height - (opts.showStats ? 11 : 2),
        xStep = data.points < opts.width/2 ? data.points < opts.width/3 ? 3 : 2 : 1,
        yStep = graphHeight/opts.hotLevel,
        yCompress = data.max > opts.hotLevel ? opts.hotLevel/data.max : 1,
        seconds = data.endSec - data.startSec,
        canvas = new Canvas(opts.width, opts.height),
        c = canvas.getContext('2d'),
        drawMark = function (second, hexColor, withFlag) {
            var x = Math.floor(opts.width + ((second - data.startSec)/seconds - 1)*data.points*xStep);
            
            c.beginPath();
            c.lineTo(x, 0);
            c.lineTo(x, graphHeight + 2);
            c.lineWidth = 1;
            c.strokeStyle = '#' + (hexColor || '666666');
            c.stroke();

            if (withFlag) {
                c.fillStyle = '#' + (hexColor || '666666');
                c.fillRect(x - 2, 0, 4, 2);
                c.fillRect(x - 1, 2, 2, 1);
            }
        };

    if (opts.showStats) {
        c.font = 'bold 9px Arial';
        c.textAlign = 'right';
        c.fillStyle = '#999999';
        c.fillText(numWithCommas(data.totalHits), opts.width - 1, opts.height - 1);
    }

    c.translate(-0.5, -0.5); // reduce antialiasing

    if (opts.showHours) {
        _.each(_.range(data.endSec, data.startSec, -3600), function(hour) {
            drawMark(hour, 'f0f0f0');
        });
    }

    _.each(data.seriesData, function(s) {
        c.beginPath();
        _.each(s.data, function(y, x){
            if (!x && data.points === opts.width) { return; }
            c.lineTo(opts.width + (x - data.points + 1)*xStep - 1, graphHeight - yStep*yCompress*y + 2); // + 2 so thick lines don't get cropped at top
        });
        c.lineWidth = s.hotness;
        c.strokeStyle = hexToRgba(s.color, opts.alpha);
        c.stroke();
    });

    if (opts.markers) {
        _.each(opts.markers.split(','), function(m) {
            m = m.split(':');
            drawMark(_.parseInt(m[0]), m[1], true);
        });
    }

    return canvas;
}

http.createServer(function (req, res) {
    var opts = _.chain(url.parse(req.url, true).query)
        .omit(function(v, key) { return !_.has(defaults, key); })
        .assign(defaults, function(a, b) { return a ? _.isNumber(b) ? a % 1 === 0 ? parseInt(a, 10) : parseFloat(a) : a : b })
        .value();

    if (!opts.page) {
        res.end();
        return;
    }

    http.request(
        {
          host: 'api.ophan.co.uk',
          path: '/api/breakdown?path=' + url.parse(opts.page).pathname
        },
        function(proxied) {
            var str = '';

            proxied.on('data', function (chunk) { str += chunk; });

            proxied.on('end', function () {
                var ophanData;

                try { ophanData = JSON.parse(str); } catch(e) { ophanData = {}; }

                if (ophanData.totalHits > 0 && _.isArray(ophanData.seriesData)) {
                    ophanData = collateOphanData(ophanData, opts);
                    
                    if (!ophanData) { res.end(); return; }
                    
                    draw(ophanData, opts).toBuffer(function(err, buf){
                        res.writeHead(200, {
                            'Content-Type': 'image/png',
                            'Content-Length': buf.length,
                            'Cache-Control': 'public,max-age=30'
                        });
                        res.end(buf, 'binary');
                    });
                } else {
                    res.end();
                }
            });
        }
    ).end();

}).listen(3000);
