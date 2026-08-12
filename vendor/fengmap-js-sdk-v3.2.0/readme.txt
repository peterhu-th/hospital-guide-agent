功能包及说明
1、fengmap.map.min.js		——地图核心模块，核心模块包括地图显示、常用覆盖物、事件、销毁、计算、地图工具等一些常用功能
2、fengmap.plugin.ui.min.js	——地图UI控件模块，依赖于核心模块使用，包含地图 UI 控件等功能
3、fengmap.analyser.min.js	——搜索分析模块，搜索查询、路径分析时引入；可独立于地图工作，支持Web Worker 和 Node
4、fengmap.effect.min.js	——特效渲染模块，依赖于核心模块使用，非特效渲染的项目不需要引入
5、fengmap.plugin.navi.min.js	——导航模块，依赖于核心模块和分析模块使用，包含导航相关功能
6、fengmap.plugin.draw.min.js	——绘图模块，依赖于核心模块使用，包含框选及绘制/编辑点线面功能，其中框选功能需要依赖于分析模块使用
7、fengmap.plugin.layers.min.js ——附加图层模块，依赖于核心模块使用，用于为地图模块增加三方底图、3D图层、地面网格等
8、fengmap.plugin.export.min.js ——地图导出模块，依赖于核心模块使用，用于将地图导出、打印为图片时使用
9、fengmap.plugin.markers.min.js ——特殊覆盖物模块，依赖于核心模块使用，用于实现复杂的图文结合的复合标注、3D线标注、墙标注等功能
10、fengmap.plugin.location.min.js	——位置服务模块，依赖于核心模块使用，目前包含轨迹回放功能，依赖于核心模块使用
11、fengmap.plugin.debug.min.js	——性能监控模块，依赖于核心模块使用，用于查看当前渲染对象的顶点数、面数以及性能统计信息。方便了解和优化渲染性能
12、fengmap.plugin.fusion.min.js	——数据融合插件包，依赖于云平台数据融合模块的融合结果和sdk核心模块使用，用于以web方式快速获取融合数据，并以marker形式添加到地图应用里
13、fengmap.plugin.loader.min.js	——JS外部模型/FBX动态模型加载器模块，依赖于sdk核心模块使用，用于加载*.js外部模型（FMExternalModel）或添加FBX格式的动态模型（FMDynamicModel）
14、fengmap.plugin.first.min.js	——第一人称视角模块，依赖于sdk核心模块使用，用于实现第一人称视角下的交互控制、小地图等相关功能

其他配置文件及说明
15、toolBarStyle.css		——楼层控件样式文件，支持自定义样式，与UI控件模块共用
16、draco_decoder.js、draco_decoder.wasm、draco_wasm_wrapper.js	——3Dtiles的解码器，依赖于核心模块和附加图层模块使用
17、fonts		——CAD文字字体文件夹，使用FMCADLayer时必须要设置的字体及目录，否则会导致CAD中的文字无法正常显示
18、workers		——web worker文件夹，FMMap初始化开启webWorker后，SDK同级目录下必须存在的文件夹，通过多个专用线程分别创建地图、加载地图以及进行相关耗时计算，以优化整体地图的加载和运行速度