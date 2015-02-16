/*
 * Copyright (C) 2014 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * @constructor
 * @implements {WebInspector.FlameChartDataProvider}
 * @param {!WebInspector.TimelineModel} model
 * @param {!WebInspector.TimelineFrameModelBase} frameModel
 */
WebInspector.TimelineFlameChartDataProvider = function(model, frameModel)
{
    WebInspector.FlameChartDataProvider.call(this);
    this.reset();
    this._model = model;
    this._frameModel = frameModel;
    this._font = "11px " + WebInspector.fontFamily();
    this._filters = [];
    this.addFilter(WebInspector.TimelineUIUtils.hiddenEventsFilter());
    this.addFilter(new WebInspector.ExclusiveTraceEventNameFilter([WebInspector.TimelineModel.RecordType.Program]));
    this._jsFramesColorGenerator = new WebInspector.FlameChart.ColorGenerator(
        { min: 180, max: 310, count: 7 },
        { min: 50, max: 80, count: 5 },
        85);
    this._consoleColorGenerator = new WebInspector.FlameChart.ColorGenerator(
        { min: 30, max: 55, count: 5 },
        { min: 70, max: 100, count: 6 },
        50, 0.7);
}

WebInspector.TimelineFlameChartDataProvider.InstantEventVisibleDurationMs = 0.001;
WebInspector.TimelineFlameChartDataProvider.JSFrameCoalesceThresholdMs = 1.1;

WebInspector.TimelineFlameChartDataProvider.prototype = {
    /**
     * @override
     * @return {number}
     */
    barHeight: function()
    {
        return 17;
    },

    /**
     * @override
     * @return {number}
     */
    textBaseline: function()
    {
        return 5;
    },

    /**
     * @override
     * @return {number}
     */
    textPadding: function()
    {
        return 4;
    },

    /**
     * @override
     * @param {number} entryIndex
     * @return {string}
     */
    entryFont: function(entryIndex)
    {
        return this._font;
    },

    /**
     * @override
     * @param {number} entryIndex
     * @return {?string}
     */
    entryTitle: function(entryIndex)
    {
        var event = this._entryEvents[entryIndex];
        if (event) {
            if (event.phase === WebInspector.TracingModel.Phase.AsyncStepInto || event.phase === WebInspector.TracingModel.Phase.AsyncStepPast)
                return event.name + ":" + event.args["step"];

            var name = WebInspector.TimelineUIUtils.eventStyle(event).title;
            // TODO(yurys): support event dividers
            var detailsText = WebInspector.TimelineUIUtils.buildDetailsTextForTraceEvent(event, this._model.target());
            if (event.name === WebInspector.TimelineModel.RecordType.JSFrame && detailsText)
                return detailsText;
            return detailsText ? WebInspector.UIString("%s (%s)", name, detailsText) : name;
        }
        var title = this._entryIndexToTitle[entryIndex];
        if (!title) {
            title = WebInspector.UIString("Unexpected entryIndex %d", entryIndex);
            console.error(title);
        }
        return title;
    },

    /**
     * @override
     * @param {number} startTime
     * @param {number} endTime
     * @return {?Array.<number>}
     */
    dividerOffsets: function(startTime, endTime)
    {
        return null;
    },

    reset: function()
    {
        this._timelineData = null;
        /** @type {!Array.<!WebInspector.TracingModel.Event>} */
        this._entryEvents = [];
        this._entryIndexToTitle = {};
        /** @type {!Array.<!WebInspector.TimelineFlameChartMarker>} */
        this._markers = [];
        this._entryIndexToFrame = {};
        this._asyncColorByCategory = {};
    },

    /**
     * @override
     * @return {!WebInspector.FlameChart.TimelineData}
     */
    timelineData: function()
    {
        if (this._timelineData)
            return this._timelineData;

        this._timelineData = new WebInspector.FlameChart.TimelineData([], [], []);

        this._flowEventIndexById = {};
        this._minimumBoundary = this._model.minimumRecordTime();
        this._timeSpan = this._model.isEmpty() ?  1000 : this._model.maximumRecordTime() - this._minimumBoundary;
        this._currentLevel = 0;
        this._appendFrameBars(this._frameModel.frames());
        this._appendThreadTimelineData(WebInspector.UIString("Main Thread"), this._model.mainThreadEvents(), this._model.mainThreadAsyncEvents());
        if (Runtime.experiments.isEnabled("gpuTimeline"))
            this._appendGPUEvents();
        var threads = this._model.virtualThreads();
        for (var i = 0; i < threads.length; i++)
            this._appendThreadTimelineData(threads[i].name, threads[i].events, threads[i].asyncEvents);

        /**
         * @param {!WebInspector.TimelineFlameChartMarker} a
         * @param {!WebInspector.TimelineFlameChartMarker} b
         */
        function compareStartTime(a, b)
        {
            return a.startTime() - b.startTime();
        }

        this._markers.sort(compareStartTime);
        this._timelineData.markers = this._markers;

        this._flowEventIndexById = {};
        return this._timelineData;
    },

    /**
     * @param {string} threadTitle
     * @param {!Array.<!WebInspector.TracingModel.Event>} syncEvents
     * @param {!Array.<!Array.<!WebInspector.TracingModel.Event>>} asyncEvents
     */
    _appendThreadTimelineData: function(threadTitle, syncEvents, asyncEvents)
    {
        var levelCount = this._appendAsyncEvents(threadTitle, asyncEvents);
        levelCount += this._appendSyncEvents(levelCount ? null : threadTitle, syncEvents);
        if (levelCount)
            ++this._currentLevel;
    },

    /**
     * @param {?string} headerName
     * @param {!Array.<!WebInspector.TracingModel.Event>} events
     * @return {boolean}
     */
    _appendSyncEvents: function(headerName, events)
    {
        var openEvents = [];
        var headerAppended = false;

        var flowEventsEnabled = Runtime.experiments.isEnabled("timelineFlowEvents");
        function isFlowEvent(event)
        {
            return e.phase === WebInspector.TracingModel.Phase.FlowBegin ||
                   e.phase === WebInspector.TracingModel.Phase.FlowStep ||
                   e.phase === WebInspector.TracingModel.Phase.FlowEnd;
        }

        var maxStackDepth = 0;
        for (var i = 0; i < events.length; ++i) {
            var e = events[i];
            if (WebInspector.TimelineUIUtils.isMarkerEvent(e))
                this._markers.push(new WebInspector.TimelineFlameChartMarker(e.startTime, e.startTime - this._model.minimumRecordTime(), WebInspector.TimelineUIUtils.markerStyleForEvent(e)));
            if (!isFlowEvent(e)) {
                if (!e.endTime && e.phase !== WebInspector.TracingModel.Phase.Instant)
                    continue;
                if (WebInspector.TracingModel.isAsyncPhase(e.phase))
                    continue;
                if (!this._isVisible(e))
                    continue;
            }
            while (openEvents.length && openEvents.peekLast().endTime <= e.startTime)
                openEvents.pop();
            if (!headerAppended && headerName) {
                this._appendHeaderRecord(headerName, this._currentLevel++);
                headerAppended = true;
            }
            var level = this._currentLevel + openEvents.length;
            this._appendEvent(e, level);
            if (flowEventsEnabled)
                this._appendFlowEvent(e, level);
            maxStackDepth = Math.max(maxStackDepth, openEvents.length + 1);
            if (e.endTime)
                openEvents.push(e);
        }
        this._currentLevel += maxStackDepth;
        return !!maxStackDepth;
    },

    /**
     * @param {string} header
     * @param {!Array.<!Array.<!WebInspector.TracingModel.Event>>} eventSteps
     */
    _appendAsyncEvents: function(header, eventSteps)
    {
        var lastUsedTimeByLevel = [];
        var headerAppended = false;

        for (var i = 0; i < eventSteps.length; ++i) {
            var e = eventSteps[i][0];
            if (!this._isVisible(e))
                continue;
            if (!headerAppended && header) {
                this._appendHeaderRecord(header, this._currentLevel++);
                headerAppended = true;
            }
            var level;
            for (level = 0; level < lastUsedTimeByLevel.length && lastUsedTimeByLevel[level] > e.startTime; ++level) {}
            if (WebInspector.TracingModel.isNestableAsyncPhase(e.phase))
                this._appendEvent(e, this._currentLevel + level);
            else
                this._appendAsyncEventSteps(eventSteps[i], this._currentLevel + level);
            var lastStep = eventSteps[i].peekLast();
            if (e.phase === WebInspector.TracingModel.Phase.AsyncBegin || e.phase === WebInspector.TracingModel.Phase.NestableAsyncInstant)
                lastUsedTimeByLevel[level] = lastStep.startTime;
            else if (e.phase === WebInspector.TracingModel.Phase.NestableAsyncBegin && e.endTime)
                lastUsedTimeByLevel[level] = e.endTime;
            else
                lastUsedTimeByLevel[level] = Infinity;
        }
        this._currentLevel += lastUsedTimeByLevel.length;
        return lastUsedTimeByLevel.length;
    },

    _appendGPUEvents: function()
    {
        function recordToEvent(record)
        {
            return record.traceEvent();
        }
        if (this._appendSyncEvents(WebInspector.UIString("GPU"), this._model.gpuTasks().map(recordToEvent)))
            ++this._currentLevel;
    },

    /**
     * @param {!Array.<!WebInspector.TimelineFrame>} frames
     */
    _appendFrameBars: function(frames)
    {
        var style = WebInspector.TimelineUIUtils.markerStyleForFrame();
        this._frameBarsLevel = this._currentLevel++;
        for (var i = 0; i < frames.length; ++i) {
            this._markers.push(new WebInspector.TimelineFlameChartMarker(frames[i].startTime, frames[i].startTime - this._model.minimumRecordTime(), style));
            this._appendFrame(frames[i]);
        }
    },

    /**
     * @param {!WebInspector.TraceEventFilter} filter
     */
    addFilter: function(filter)
    {
        this._filters.push(filter);
    },

    /**
     * @param {!WebInspector.TracingModel.Event} event
     * @return {boolean}
     */
    _isVisible: function(event)
    {
        return this._filters.every(function (filter) { return filter.accept(event); });
    },

    /**
     * @override
     * @return {number}
     */
    minimumBoundary: function()
    {
        return this._minimumBoundary;
    },

    /**
     * @override
     * @return {number}
     */
    totalTime: function()
    {
        return this._timeSpan;
    },

    /**
     * @override
     * @return {number}
     */
    maxStackDepth: function()
    {
        return this._currentLevel;
    },

    /**
     * @override
     * @param {number} entryIndex
     * @return {?Array.<!{title: string, text: string}>}
     */
    prepareHighlightedEntryInfo: function(entryIndex)
    {
        return null;
    },

    /**
     * @override
     * @param {number} entryIndex
     * @return {boolean}
     */
    canJumpToEntry: function(entryIndex)
    {
        return false;
    },

    /**
     * @override
     * @param {number} entryIndex
     * @return {string}
     */
    entryColor: function(entryIndex)
    {
        var event = this._entryEvents[entryIndex];
        if (!event)
            return this._entryIndexToFrame[entryIndex] ? "white" : "#aaa";
        if (event.name === WebInspector.TimelineModel.RecordType.JSFrame) {
            var colorId = event.args["data"]["url"];
            return this._jsFramesColorGenerator.colorForID(colorId);
        }
        var category = WebInspector.TimelineUIUtils.eventStyle(event).category;
        if (WebInspector.TracingModel.isAsyncPhase(event.phase)) {
            if (event.category === WebInspector.TracingModel.ConsoleEventCategory)
                return this._consoleColorGenerator.colorForID(event.name);
            var color = this._asyncColorByCategory[category.name];
            if (color)
                return color;
            var parsedColor = WebInspector.Color.parse(category.fillColorStop1);
            color = parsedColor.setAlpha(0.7).asString(WebInspector.Color.Format.RGBA) || "";
            this._asyncColorByCategory[category.name] = color;
            return color;
        }
        return category.fillColorStop1;
    },

    /**
     * @override
     * @param {number} entryIndex
     * @param {!CanvasRenderingContext2D} context
     * @param {?string} text
     * @param {number} barX
     * @param {number} barY
     * @param {number} barWidth
     * @param {number} barHeight
     * @return {boolean}
     */
    decorateEntry: function(entryIndex, context, text, barX, barY, barWidth, barHeight)
    {
        var frame = this._entryIndexToFrame[entryIndex];
        if (frame) {
            var /** @const */ vPadding = 1;
            var /** @const */ hPadding = 2;
            barX += hPadding;
            barWidth -= 2 * hPadding;
            barY += vPadding;
            barHeight -= 2 * vPadding + 1;

            context.fillStyle = "#ccc";
            context.fillRect(barX, barY, barWidth, barHeight);

            // Draw frame perforation.
            context.fillStyle = "white";
            for (var i = 1; i < barWidth; i += 4) {
                context.fillRect(barX + i, barY + 1, 2, 2);
                context.fillRect(barX + i, barY + barHeight - 3, 2, 2);
            }

            var frameDurationText = Number.preciseMillisToString(frame.duration, 1);
            var textWidth = context.measureText(frameDurationText).width;
            if (barWidth > textWidth) {
                context.fillStyle = "#333";
                context.fillText(frameDurationText, barX + ((barWidth - textWidth) >> 1), barY + barHeight - 3);
            }
            return true;
        }
        if (barWidth < 5)
            return false;

        if (text) {
            context.save();
            context.fillStyle = "#333";
            context.font = this._font;
            context.fillText(text, barX + this.textPadding(), barY + barHeight - this.textBaseline());
            context.restore();
        }

        var event = this._entryEvents[entryIndex];
        if (event && event.warning) {
            context.save();

            context.rect(barX, barY, barWidth, this.barHeight());
            context.clip();

            context.beginPath();
            var /** @const */ triangleSize = 10;
            context.fillStyle = "red";
            context.moveTo(barX + barWidth - triangleSize, barY + 1);
            context.lineTo(barX + barWidth - 1, barY + 1);
            context.lineTo(barX + barWidth - 1, barY + triangleSize);
            context.fill();

            context.restore();
        }

        return true;
    },

    /**
     * @override
     * @param {number} entryIndex
     * @return {boolean}
     */
    forceDecoration: function(entryIndex)
    {
        var event = this._entryEvents[entryIndex];
        if (!event)
            return !!this._entryIndexToFrame[entryIndex];
        return !!event.warning;
    },

   /**
    * @override
     * @param {number} entryIndex
     * @return {?{startTime: number, endTime: number}}
     */
    highlightTimeRange: function(entryIndex)
    {
        var startTime = this._timelineData.entryStartTimes[entryIndex];
        if (!startTime)
            return null;
        return {
            startTime: startTime,
            endTime: startTime + this._timelineData.entryTotalTimes[entryIndex]
        };
    },

    /**
     * @override
     * @return {number}
     */
    paddingLeft: function()
    {
        return 0;
    },

    /**
     * @override
     * @param {number} entryIndex
     * @return {string}
     */
    textColor: function(entryIndex)
    {
        return "white";
    },

    /**
     * @param {string} title
     * @param {number} level
     */
    _appendHeaderRecord: function(title, level)
    {
        var index = this._entryEvents.length;
        this._entryIndexToTitle[index] = title;
        this._entryEvents.push(null);
        this._timelineData.entryLevels[index] = level;
        this._timelineData.entryTotalTimes[index] = this._timeSpan;
        this._timelineData.entryStartTimes[index] = this._minimumBoundary;
    },

    /**
     * @param {!WebInspector.TracingModel.Event} event
     * @param {number} level
     */
    _appendEvent: function(event, level)
    {
        var index = this._entryEvents.length;
        this._entryEvents.push(event);
        this._timelineData.entryLevels[index] = level;
        this._timelineData.entryTotalTimes[index] = event.duration || WebInspector.TimelineFlameChartDataProvider.InstantEventVisibleDurationMs;
        this._timelineData.entryStartTimes[index] = event.startTime;
    },

    /**
     * @param {!WebInspector.TracingModel.Event} event
     * @param {number} level
     */
    _appendFlowEvent: function(event, level)
    {
        var timelineData = this._timelineData;
        /**
         * @param {!WebInspector.TracingModel.Event} event
         * @return {number}
         */
        function pushStartFlow(event)
        {
            var flowIndex = timelineData.flowStartTimes.length;
            timelineData.flowStartTimes.push(event.startTime);
            timelineData.flowStartLevels.push(level);
            return flowIndex;
        }

        /**
         * @param {!WebInspector.TracingModel.Event} event
         * @param {number} flowIndex
         */
        function pushEndFlow(event, flowIndex)
        {
            timelineData.flowEndTimes[flowIndex] = event.startTime;
            timelineData.flowEndLevels[flowIndex] = level;
        }

        switch(event.phase) {
        case WebInspector.TracingModel.Phase.FlowBegin:
            this._flowEventIndexById[event.id] = pushStartFlow(event);
            break;
        case WebInspector.TracingModel.Phase.FlowStep:
            pushEndFlow(event, this._flowEventIndexById[event.id]);
            this._flowEventIndexById[event.id] = pushStartFlow(event);
            break;
        case WebInspector.TracingModel.Phase.FlowEnd:
            pushEndFlow(event, this._flowEventIndexById[event.id]);
            delete this._flowEventIndexById[event.id];
            break;
        }
    },

    /**
     * @param {!Array.<!WebInspector.TracingModel.Event>} steps
     * @param {number} level
     */
    _appendAsyncEventSteps: function(steps, level)
    {
        // If we have past steps, put the end event for each range rather than start one.
        var eventOffset = steps[1].phase === WebInspector.TracingModel.Phase.AsyncStepPast ? 1 : 0;
        for (var i = 0; i < steps.length - 1; ++i) {
            var index = this._entryEvents.length;
            this._entryEvents.push(steps[i + eventOffset]);
            var startTime = steps[i].startTime;
            this._timelineData.entryLevels[index] = level;
            this._timelineData.entryTotalTimes[index] = steps[i + 1].startTime - startTime;
            this._timelineData.entryStartTimes[index] = startTime;
        }
    },

    /**
     * @param {!WebInspector.TimelineFrame} frame
     */
    _appendFrame: function(frame)
    {
        var index = this._entryEvents.length;
        this._entryEvents.push(null);
        this._entryIndexToFrame[index] = frame;
        this._entryIndexToTitle[index] = Number.millisToString(frame.duration, true);
        this._timelineData.entryLevels[index] = this._frameBarsLevel;
        this._timelineData.entryTotalTimes[index] = frame.duration;
        this._timelineData.entryStartTimes[index] = frame.startTime;
    },

    /**
     * @param {number} entryIndex
     * @return {?WebInspector.TimelineSelection}
     */
    createSelection: function(entryIndex)
    {
        var event = this._entryEvents[entryIndex];
        if (event) {
            this._lastSelection = new WebInspector.TimelineFlameChart.Selection(WebInspector.TimelineSelection.fromTraceEvent(event), entryIndex);
            return this._lastSelection.timelineSelection;
        }
        var frame = this._entryIndexToFrame[entryIndex];
        if (frame) {
            this._lastSelection = new WebInspector.TimelineFlameChart.Selection(WebInspector.TimelineSelection.fromFrame(frame), entryIndex);
            return this._lastSelection.timelineSelection;
        }
        return null;
    },

    /**
     * @param {?WebInspector.TimelineSelection} selection
     * @return {number}
     */
    entryIndexForSelection: function(selection)
    {
        if (!selection)
            return -1;

        if (this._lastSelection && this._lastSelection.timelineSelection.object() === selection.object())
            return this._lastSelection.entryIndex;
        switch  (selection.type()) {
        case WebInspector.TimelineSelection.Type.TraceEvent:
            var event = /** @type{!WebInspector.TracingModel.Event} */ (selection.object());
            var entryEvents = this._entryEvents;
            for (var entryIndex = 0; entryIndex < entryEvents.length; ++entryIndex) {
                if (entryEvents[entryIndex] === event) {
                    this._lastSelection = new WebInspector.TimelineFlameChart.Selection(WebInspector.TimelineSelection.fromTraceEvent(event), entryIndex);
                    return entryIndex;
                }
            }
            break;
        case WebInspector.TimelineSelection.Type.Frame:
            var frame = /** @type {!WebInspector.TimelineFrame} */ (selection.object());
            for (var frameIndex in this._entryIndexToFrame) {
                if (this._entryIndexToFrame[frameIndex] === frame) {
                    this._lastSelection = new WebInspector.TimelineFlameChart.Selection(WebInspector.TimelineSelection.fromFrame(frame), Number(frameIndex));
                    return Number(frameIndex);
                }
            }
            break;
        }
        return -1;
    }
}

/**
 * @constructor
 * @implements {WebInspector.FlameChartMarker}
 * @param {number} startTime
 * @param {number} startOffset
 * @param {!WebInspector.TimelineMarkerStyle} style
 */
WebInspector.TimelineFlameChartMarker = function(startTime, startOffset, style)
{
    this._startTime = startTime;
    this._startOffset = startOffset;
    this._style = style;
}

WebInspector.TimelineFlameChartMarker.prototype = {
    /**
     * @override
     * @return {number}
     */
    startTime: function()
    {
        return this._startTime;
    },

    /**
     * @override
     * @return {string}
     */
    color: function()
    {
        return this._style.color;
    },

    /**
     * @override
     * @return {string}
     */
    title: function()
    {
        var startTime = Number.millisToString(this._startOffset);
        return WebInspector.UIString("%s at %s", this._style.title, startTime);
    },

    /**
     * @override
     * @param {!CanvasRenderingContext2D} context
     * @param {number} x
     * @param {number} height
     * @param {number} pixelsPerMillisecond
     */
    draw: function(context, x, height, pixelsPerMillisecond)
    {
        var lowPriorityVisibilityThresholdInPixelsPerMs = 4;

        if (this._style.lowPriority && pixelsPerMillisecond < lowPriorityVisibilityThresholdInPixelsPerMs)
            return;
        context.save();

        if (!this._style.lowPriority) {
            context.strokeStyle = this._style.color;
            context.lineWidth = 2;
            context.beginPath();
            context.moveTo(x, 0);
            context.lineTo(x, height);
            context.stroke();
        }

        if (this._style.tall) {
            context.strokeStyle = this._style.color;
            context.lineWidth = this._style.lineWidth;
            context.translate(this._style.lineWidth < 1 || (this._style.lineWidth & 1) ? 0.5 : 0, 0.5);
            context.beginPath();
            context.moveTo(x, height);
            context.setLineDash(this._style.dashStyle);
            context.lineTo(x, context.canvas.height);
            context.stroke();
        }
        context.restore();
    }
}

/**
 * @constructor
 * @extends {WebInspector.VBox}
 * @implements {WebInspector.TimelineModeView}
 * @implements {WebInspector.FlameChartDelegate}
 * @param {!WebInspector.TimelineModeViewDelegate} delegate
 * @param {!WebInspector.TimelineModel} timelineModel
 * @param {!WebInspector.TimelineFrameModelBase} frameModel
 */
WebInspector.TimelineFlameChart = function(delegate, timelineModel, frameModel)
{
    WebInspector.VBox.call(this);
    this.element.classList.add("timeline-flamechart");
    this._delegate = delegate;
    this._model = timelineModel;
    this._dataProvider = new WebInspector.TimelineFlameChartDataProvider(timelineModel, frameModel);
    this._mainView = new WebInspector.FlameChart(this._dataProvider, this, true);
    this._mainView.show(this.element);
    this._model.addEventListener(WebInspector.TimelineModel.Events.RecordingStarted, this._onRecordingStarted, this);
    this._mainView.addEventListener(WebInspector.FlameChart.Events.EntrySelected, this._onEntrySelected, this);
}

WebInspector.TimelineFlameChart.prototype = {
    /**
     * @override
     */
    dispose: function()
    {
        this._model.removeEventListener(WebInspector.TimelineModel.Events.RecordingStarted, this._onRecordingStarted, this);
        this._mainView.removeEventListener(WebInspector.FlameChart.Events.EntrySelected, this._onEntrySelected, this);
    },

    /**
     * @override
     * @param {number} windowStartTime
     * @param {number} windowEndTime
     */
    requestWindowTimes: function(windowStartTime, windowEndTime)
    {
        this._delegate.requestWindowTimes(windowStartTime, windowEndTime);
    },

    /**
     * @override
     * @param {number} startTime
     * @param {number} endTime
     */
    updateBoxSelection: function(startTime, endTime)
    {
        this._delegate.select(WebInspector.TimelineSelection.fromRange(startTime, endTime));
    },

    /**
     * @override
     * @param {?RegExp} textFilter
     */
    refreshRecords: function(textFilter)
    {
        this._dataProvider.reset();
        this._mainView.scheduleUpdate();
    },

    wasShown: function()
    {
        this._mainView.scheduleUpdate();
    },

    /**
     * @override
     * @return {!WebInspector.View}
     */
    view: function()
    {
        return this;
    },

    /**
     * @override
     */
    reset: function()
    {
        this._automaticallySizeWindow = true;
        this._dataProvider.reset();
        this._mainView.reset();
        this._mainView.setWindowTimes(0, Infinity);
    },

    _onRecordingStarted: function()
    {
        this._automaticallySizeWindow = true;
        this._mainView.reset();
    },

    /**
     * @override
     * @param {number} startTime
     * @param {number} endTime
     */
    setWindowTimes: function(startTime, endTime)
    {
        this._mainView.setWindowTimes(startTime, endTime);
        this._delegate.select(null);
    },

    /**
     * @override
     * @param {number} width
     */
    setSidebarSize: function(width)
    {
    },

    /**
     * @override
     * @param {?WebInspector.TimelineModel.Record} record
     * @param {string=} regex
     * @param {boolean=} selectRecord
     */
    highlightSearchResult: function(record, regex, selectRecord)
    {
        if (!record) {
            this._delegate.select(null);
            return;
        }
        var traceEvent = record.traceEvent();
        var entryIndex = this._dataProvider._entryEvents.indexOf(traceEvent);
        var timelineSelection = this._dataProvider.createSelection(entryIndex);
        if (timelineSelection)
            this._delegate.select(timelineSelection);
    },

    /**
     * @override
     * @param {?WebInspector.TimelineSelection} selection
     */
    setSelection: function(selection)
    {
        var index = this._dataProvider.entryIndexForSelection(selection);
        this._mainView.setSelectedEntry(index);
    },

    /**
     * @param {!WebInspector.Event} event
     */
    _onEntrySelected: function(event)
    {
        var entryIndex = /** @type{number} */ (event.data);
        var timelineSelection = this._dataProvider.createSelection(entryIndex);
        if (timelineSelection)
            this._delegate.select(timelineSelection);
    },

    __proto__: WebInspector.VBox.prototype
}

/**
  * @constructor
  * @param {!WebInspector.TimelineSelection} selection
  * @param {number} entryIndex
  */
WebInspector.TimelineFlameChart.Selection = function(selection, entryIndex)
{
    this.timelineSelection = selection;
    this.entryIndex = entryIndex;
}
