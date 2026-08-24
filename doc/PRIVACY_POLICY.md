# Isu 新标签页隐私政策

最后更新日期：2026 年 8 月 23 日

Isu 新标签页（以下简称“Isu”或“本扩展”）是一款用于自定义 Chrome 新标签页的扩展。本政策说明 Isu 如何处理用户数据，以及用户可以如何控制这些数据。

## 一、我们处理的数据

### 1. 桌面配置和快捷方式

Isu 可以在浏览器本地保存时钟、搜索框、便签、专注计时器、快捷方式、文件夹、布局、主题和壁纸设置。这些数据用于显示和恢复用户自定义的新标签页。

用户主动启用 Chrome Sync 时，适合跨设备使用的轻量配置（例如快捷方式、文件夹、桌面位置、组件设置和在线壁纸网址）可能由 Chrome Sync 在用户的设备之间同步。

以下内容不通过 Isu 的同步功能同步：

- 本地上传的壁纸文件；
- 便签内容；
- 搜索历史；
- Unsplash Access Key；
- 壁纸图片缓存。
- 在线随机壁纸当前图片、缓存与下次切换时间。
- 天气组件的位置坐标、温度单位偏好和天气响应。

### 2. 搜索历史和搜索建议

默认情况下，Isu 的搜索历史仅保存在当前设备的浏览器本地存储中，不会进入 Isu 的同步数据。

用户可以在设置中主动选择“Chrome 历史”来源。只有在用户主动选择并授权后，Isu 才会读取 Chrome 浏览历史中的记录，从受支持的搜索结果页面提取搜索词，并在搜索框中显示建议。Isu 不会添加、修改、删除或上传 Chrome 浏览历史。

当用户启用搜索建议时，用户在搜索框中输入的文字会发送到当前选择的搜索引擎建议服务（Google Suggest 或 Bing），以返回搜索建议。用户可以随时在设置中关闭搜索建议。

切回本地搜索历史或关闭搜索历史后，Isu 会撤销 Chrome 历史权限。Chrome 历史是否包含其他设备的记录，取决于用户自己的 Chrome 登录状态、同步设置和浏览器隐私策略。

### 3. 壁纸和在线服务

- Wallhaven：当用户搜索、选择或启用在线随机壁纸时，Isu 会请求 Wallhaven 的搜索接口和壁纸资源。
- Unsplash：当用户选择 Unsplash 作为来源并提供 Access Key 后，Isu 会使用该密钥请求 Unsplash 官方 API，搜索和显示壁纸，并按照 Unsplash 要求发送下载跟踪请求。
- 本地壁纸：用户上传的壁纸只保存在当前浏览器的本地存储中，除非用户主动将其包含在本地备份文件中。

Unsplash Access Key 仅保存在当前浏览器的本地存储中，不进入 Chrome Sync、Isu 配置导出或 Isu 的服务器。使用 Unsplash API 时，该密钥会按 API 要求发送至 Unsplash。

### 4. 每日一语

当界面使用中文时，Isu 会向一言（Hitokoto）请求中文每日一言；当界面使用英文时，Isu 会向 ZenQuotes 请求英文每日一言。缓存不进入 Chrome Sync、配置导出或备份。

与任何 HTTPS 请求一样，第三方服务可能获得正常提供服务所需的网络信息，例如 IP 地址和请求时间。

### 5. 天气和位置

用户主动启用天气组件或点击“使用当前位置 / 重试”时，Isu 才会通过浏览器读取当前位置；不会在启动、同步恢复或仅显示天气组件时自动读取位置。

位置坐标、城市名、温度单位偏好和天气结果只保存在当前设备。天气结果缓存 60 分钟；为了获取天气，Isu 会将经纬度和所选温度单位通过 HTTPS 发送给 Open-Meteo。

## 二、我们不会做什么

Isu 不会：

- 出售用户数据；
- 将用户数据用于与扩展单一用途无关的广告、画像或信用评估；
- 读取普通网页的页面内容、Cookie、密码或表单数据；
- 将便签、快捷方式配置或本地壁纸上传到 Isu 自有服务器；
- 修改、伪造或删除 Chrome 浏览历史；
- 使用远程 JavaScript、WebAssembly 或 `eval()` 执行远程代码。

Isu 没有自有的用户账号系统，也不会要求用户向 Isu 提供姓名、邮箱、手机号、支付信息或身份信息。

## 三、数据保存和删除

用户可以通过以下方式控制数据：

- 在设置中删除或修改快捷方式、文件夹和组件布局；
- 在搜索设置中清除 Isu 本地搜索历史；
- 切换回本地历史或关闭搜索历史，撤销 Chrome 历史权限；
- 在设置中清除 Unsplash Access Key；
- 在 Chrome 扩展管理页面卸载 Isu，删除本扩展保存的本地数据；
- 删除用户自行导出的 ZIP 备份文件及其中的壁纸。

Chrome 历史本身由 Chrome 管理。Isu 不提供删除 Chrome 历史的功能，用户需要通过 Chrome 的历史记录页面管理这些记录。

## 四、权限用途

本扩展使用的权限仅用于以下目的：

- `storage`：保存设置、同步状态和本地数据；
- `unlimitedStorage`：保存本地壁纸、缓存图片和较大的 IndexedDB 数据；
- `search`：在当前标签页使用用户在 Isu 中选择的 Google 或 Bing 搜索引擎；
- `favicon`：显示快捷方式网站的图标；
- `contextMenus`：在 Chrome 原生右键菜单中提供 Isu 操作；
- `geolocation`：仅在用户主动启用天气组件或点击位置重试时读取当前位置，用于向 Open-Meteo 请求天气；
- `alarms`：仅用于在线随机壁纸的本机定时切换；
- `history`（可选）：仅在用户主动授权后读取 Chrome 浏览历史中的搜索结果页；
- Wallhaven、Unsplash、Google Suggest、Bing、Open-Meteo、OpenStreetMap Nominatim、一言和 ZenQuotes 的网站权限：分别用于壁纸搜索、壁纸显示/跟踪、搜索建议、天气、城市名称和每日一语。

## 五、数据安全

Isu 使用 HTTPS 访问在线服务，并通过浏览器提供的本地存储和 IndexedDB 保存本地数据。用户应妥善保管自行导出的备份文件和 Unsplash Access Key，不要将其发布到公共位置。

## 六、第三方服务

Isu 可能连接以下第三方服务：

- [Google Suggest](https://suggestqueries.google.com/)
- [Bing](https://www.bing.com/)
- [Wallhaven](https://wallhaven.cc/)
- [Unsplash](https://unsplash.com/)
- [Open-Meteo](https://open-meteo.com/)
- [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/)
- [一言（Hitokoto）](https://hitokoto.cn/)
- [ZenQuotes](https://zenquotes.io/)

这些服务对数据的处理受其各自的隐私政策和服务条款约束。Isu 不控制第三方服务的隐私实践。

## 七、政策变更

如果 Isu 的数据处理方式发生重大变化，我们会更新本页面的“最后更新日期”，并在扩展界面页面中提供相应说明。

## 八、联系我们

隐私问题或数据请求请联系：**3039213175@qq.com**。
