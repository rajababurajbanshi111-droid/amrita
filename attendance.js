/**
 * SMART WEBRTC CLASSROOM - Attendance Management Engine
 * Real-time student attendance tracking, roll-number verification,
 * and RFC-4180 CSV spreadsheet export for academic record keeping.
 */

class AttendanceManager {
  constructor() {
    this.records = new Map(); // studentId -> { id, name, rollNo, joinTime, status }
  }

  recordStudent(student, status = 'Present') {
    if (!student || !student.id) return null;
    const existing = this.records.get(student.id);
    const joinTime = existing
      ? existing.joinTime
      : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const rec = {
      id: student.id,
      name: student.name || 'Student',
      rollNo: student.rollNo || (student.clientInfo && student.clientInfo.rollNo) || 'N/A',
      joinTime: joinTime,
      status: status
    };
    this.records.set(student.id, rec);
    return rec;
  }

  getPresentCount() {
    let count = 0;
    this.records.forEach((rec) => {
      if (rec.status === 'Present') count++;
    });
    return count;
  }

  exportCSV(roomCode = 'Classroom') {
    const rows = [['Student Name', 'Roll Number', 'Join Time', 'Status']];
    this.records.forEach((rec) => {
      rows.push([
        `"${(rec.name || '').replace(/"/g, '""')}"`,
        `"${(rec.rollNo || 'N/A').replace(/"/g, '""')}"`,
        `"${(rec.joinTime || '').replace(/"/g, '""')}"`,
        `"${(rec.status || 'Present').replace(/"/g, '""')}"`
      ]);
    });

    const csvContent = rows.map((r) => r.join(',')).join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Amrita_Attendance_Room_${roomCode}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 500);
  }
}

window.AttendanceManager = AttendanceManager;