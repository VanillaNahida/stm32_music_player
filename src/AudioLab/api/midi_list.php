<?php
/**
 * 示例曲库接口：扫描 ../example 目录，返回 MIDI 文件列表
 * 输出: {"files":[{"name":"xxx.mid"}, ...]}
 */
header('Content-Type: application/json; charset=utf-8');

$dir = dirname(__DIR__) . '/example';

$names = [];
if (is_dir($dir)) {
    $entries = scandir($dir);
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        if (is_file($dir . '/' . $entry) && preg_match('/\.(mid|midi)$/i', $entry)) {
            $names[] = $entry;
        }
    }
}

usort($names, 'strnatcasecmp');

$files = array_map(static function ($name) {
    return ['name' => $name];
}, $names);

echo json_encode(['files' => $files], JSON_UNESCAPED_UNICODE);
