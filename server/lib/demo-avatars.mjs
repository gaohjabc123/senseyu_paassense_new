// 演示环境用的系统形象样例：截图里那 8 个公共形象的真实数据
// （2026-11-17 由平台 appearance/list 接口实测拉回：POST /api/2dvh/v1/material/appearance/list）。
// 真实环境走 live 列表（60 个）；演示环境不调平台接口，只展示这 8 个样例，点选后填入的编号与模型地址同样是真实值，
// 但演示提交只返回样例结果、不真正生成。faceFeatureId / pkgUrl 是平台公开的形象标识，不是密钥。
export const DEMO_AVATARS = [
  {
    "id": 4255826,
    "name": "子沫_校园_站姿",
    "thumbnailUrl": "https://dwg-aigc-paas-prod.tos-cn-shanghai.volces.com/materials/627/子沫_校园_站姿img_1787056644836_20261022111318163.png",
    "pkgUrl": "https://dwg-aigc-paas-prod.tos-cn-shanghai.volces.com/materials/627/20260814021500_401b76f6be13433c861e91c85644a8ea_20261022111207426.zip",
    "faceFeatureId": "65d03d6476e2403daf20bb81e6874ff5_s1_2",
    "gender": 1,
    "avatarType": 1
  },
  {
    "id": 3662484,
    "name": "杜老师-交互数字人",
    "thumbnailUrl": "https://dwg-aigc-paas-prod.tos-cn-shanghai.volces.com/materials/627/1999574e933740a980f31cb4f9324e87_s1_input_source_2_result_20260803112043323.png",
    "pkgUrl": "https://dwg-aigc-paas.oss-cn-hangzhou.aliyuncs.com/CCTEST/%E5%8A%A8%E9%9D%99%E6%B5%8B%E8%AF%95/nan/result-nan-3_10.zip",
    "faceFeatureId": "1999574e933740a980f31cb4f9324e87_s1_0",
    "gender": 2,
    "avatarType": 3
  },
  {
    "id": 3983750,
    "name": "阿凌-互动数字人",
    "thumbnailUrl": "https://dwg-aigc-paas-prod.tos-cn-shanghai.volces.com/materials/627/img_1764558444207 (2)_20260602172738232_20260914172630404.png",
    "pkgUrl": "https://oss-aigc-prod.softsugar.com/download/116/99965caf8915476884f6b9dc23120e15_s1/input_source/2/99965caf8915476884f6b9dc23120e15_s1_input_source_2_result.zip",
    "faceFeatureId": "5c7d8e0c04114627bb256915528bb744_s1_2",
    "gender": 1,
    "avatarType": 3
  },
  {
    "id": 3097357,
    "name": "文文-互动数字人",
    "thumbnailUrl": "https://dwg-aigc-paas-prod.tos-cn-shanghai.volces.com/materials/627/f7b7fdfd3241440582e8536cb5e04b4d_s1_input_source_2_result_20260428153805917.png",
    "pkgUrl": "https://oss-aigc-prod.softsugar.com/download/116/e55592b750d747e59488bceeba044ce4_s1/input_source/2/e55592b750d747e59488bceeba044ce4_s1_input_source_2_result.zip",
    "faceFeatureId": "f7b7fdfd3241440582e8536cb5e04b4d_s1_2",
    "gender": 1,
    "avatarType": 3
  },
  {
    "id": 3097355,
    "name": "凡凡-互动数字人",
    "thumbnailUrl": "https://dwg-aigc-paas-prod.tos-cn-shanghai.volces.com/materials/627/a88baef2e18d497b85de15943283d94e_s1_input_source_2_result_20260428153656526.png",
    "pkgUrl": "https://oss-aigc-prod.softsugar.com/download/116/e8ec934b72334d32b234970fa0577c66_s1/input_source/2/e8ec934b72334d32b234970fa0577c66_s1_input_source_2_result.zip",
    "faceFeatureId": "a88baef2e18d497b85de15943283d94e_s1_2",
    "gender": 1,
    "avatarType": 3
  },
  {
    "id": 167343,
    "name": "芸馨_直播_站姿",
    "thumbnailUrl": "https://dwg-aigc-paas.oss-cn-hangzhou.aliyuncs.com/materials/77/thumb_20230831101051929.png",
    "pkgUrl": "https://dwg-aigc-paas.oss-cn-hangzhou.aliyuncs.com/materials/77/5482c76b3e8c4ef4bec8e76d4494f3ca_s1_input_source_2_result_20250427112413129.zip",
    "faceFeatureId": "5482c76b3e8c4ef4bec8e76d4494f3ca_s1_1",
    "gender": 1,
    "avatarType": 1
  },
  {
    "id": 203841,
    "name": "黛黛_职业_坐姿",
    "thumbnailUrl": "https://dwg-aigc-paas.oss-cn-hangzhou.aliyuncs.com/materials/77/img_1703230276960_20250115145819713.png",
    "pkgUrl": "https://dwg-aigc-paas.oss-cn-hangzhou.aliyuncs.com/materials/77/b73dd846d7f34503b6d6e2bfd7507e27_s1_20230913195647553.zip",
    "faceFeatureId": "b73dd846d7f34503b6d6e2bfd7507e27_s1",
    "gender": 1,
    "avatarType": 1
  },
  {
    "id": 993895,
    "name": "动作编辑数字人-男",
    "thumbnailUrl": "https://dwg-aigc-paas.oss-cn-hangzhou.aliyuncs.com/materials/77/76af859fda5b4ac39bcbdd8bbeeb5062_s1_input_source_2_result_20241217160100590.png",
    "pkgUrl": " https://dwg-aigc-paas.oss-cn-hangzhou.aliyuncs.com/Xproject/dongzuobianji/76af859fda5b4ac39bcbdd8bbeeb5062_s1_input_source_2_result_update.zip",
    "faceFeatureId": "76af859fda5b4ac39bcbdd8bbeeb5062_s1_2",
    "gender": 2,
    "avatarType": 4
  }
];
