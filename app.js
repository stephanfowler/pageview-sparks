"use strict";

var defaults = {
        width:       100,
        height:      40,

        pvmHot:      50,
        pvmWarm:     25,
        pvmPeriod:   5,

        showStats:   true,
        showHours:   true,
        
        statsHeight: 11
    },

    Canvas = require('canvas'),
    http = require('http'),
    url = require('url'),
    _ = require('lodash');

function resample(input, newLen) {
    var inputLen = input.length,
        span,
        lim = function(x) {
            return Math.min(x, inputLen - 1);
        };
       
    if (inputLen <= newLen) { return input; }
   
    span = inputLen / newLen;

    return _.map(_.range(inputLen, 0, -span), function(right){
        var left = right - span,
            lf = Math.floor(left),
            lc = Math.ceil(left),
            rf = Math.floor(right),
            rc = Math.ceil(right);

        return (
            _.reduce(_.range(lim(lc), lim(rf)), function(sum, i) { return sum + input[i]; }, 0) +
            input[lim(lf)] * (lc - left) +
            input[lim(rc)] * (right - rf)
        ) / span;
    }).reverse();
}

function collateOphanData(data, opts) {
    var graphs = [
            {name: 'Other',    color: 'd61d00'},
            {name: 'Google',   color: '89A54E'},
            {name: 'Guardian', color: '4572A7'}
        ];

    if(data.seriesData && data.seriesData.length) {
        _.each(data.seriesData, function(s){
            // Pick the relevant graph...
            var graph = _.find(graphs, function(g){
                    return g.name === s.name;
                }) || graphs[0]; // ...defaulting to the first ('Other')

            // Drop the last data point
            s.data.pop();

            // ...sum the data into the graph
            graph.data = graph.data || [];
            _.each(s.data, function(d,i) {
                graph.data[i] = (graph.data[i] || 0) + d.count;
            });
        });

        graphs = _.map(graphs, function(graph){
            var pvm;

            graph.data = resample(graph.data, opts.width);
            // recent pageviews per minute average
            pvm = _.reduce(_.last(graph.data, opts.pvmPeriod), function(m, n){ return m + n; }, 0) / opts.pvmPeriod;
            // classify activity on scale of 1,2,3
            graph.activity = pvm < opts.pvmHot ? pvm < opts.pvmWarm ? 1 : 2 : 3;
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

function numWithCommas(x) {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function draw(data, opts) {
    var graphHeight = opts.height - (opts.showStats ? opts.statsHeight : 2),
        xStep = data.points < opts.width/2 ? data.points < opts.width/3 ? 3 : 2 : 1,
        yStep = graphHeight/opts.pvmHot,
        yCompress = data.max > opts.pvmHot ? opts.pvmHot/data.max : 1,
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
        c.lineWidth = s.activity;
        c.strokeStyle = '#' + s.color;
        c.stroke();
    });

    if (opts.markers) {
        _.each(opts.markers.split(','), function(m) {
            m = m.split(':');
            drawMark(parseInt(m[0], 10), m[1], true);
        });
    }

    return canvas;
}

http.createServer(function (req, res) {
    var defaulter = _.partialRight(_.assign, function(a, b) {
            return a ? parseInt(a, 10) : b;
        }),
        opts = defaulter(url.parse(req.url, true).query, defaults);

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
                    draw(collateOphanData(ophanData, opts), opts).toBuffer(function(err, buf){
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
