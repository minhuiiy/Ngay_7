let userModel = require("../schemas/users");
let roleModel = require("../schemas/roles");
let bcrypt = require('bcrypt');
let crypto = require('crypto');
let nodemailer = require('nodemailer');

module.exports = {
    CreateAnUser: async function (username, password, email, role, session,
        fullName, avatarUrl, status, loginCount
    ) {
        let newUser = new userModel({
            username: username,
            password: password,
            email: email,
            fullName: fullName,
            avatarUrl: avatarUrl,
            status: status,
            role: role,
            loginCount: loginCount
        })
        await newUser.save({ session });
        return newUser;
    },
    FindUserByUsername: async function (username) {
        return await userModel.findOne({
            isDeleted: false,
            username: username
        })
    }, FindUserByEmail: async function (email) {
        return await userModel.findOne({
            isDeleted: false,
            email: email
        })
    },
    FindUserByToken: async function (token) {
        let result = await userModel.findOne({
            isDeleted: false,
            forgotPasswordToken: token
        })
        if (result.forgotPasswordTokenExp > Date.now()) {
            return result;
        }
        return false
    },
    CompareLogin: async function (user, password) {
        if (bcrypt.compareSync(password, user.password)) {
            user.loginCount = 0;
            await user.save()
            return user;
        }
        user.loginCount++;
        if (user.loginCount == 3) {
            user.lockTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
            user.loginCount = 0;
        }
        await user.save()
        return false;
    },
    GetUserById: async function (id) {
        try {
            let user = await userModel.findOne({
                _id: id,
                isDeleted: false
            }).populate('role')
            return user;
        } catch (error) {
            return false;
        }
    },
    ImportUsersFromFile: async function (filepath) {
        let excel = require('exceljs');
        try {
            // Lấy role "user" từ database (không phân biệt chữ hoa/thường)
            let userRole = await roleModel.findOne({ name: { $regex: /^user$/i } });
            
            // Nếu chưa có role này trong DB thì tự động tạo luôn
            if (!userRole) {
                userRole = new roleModel({ name: 'USER', description: 'User role' });
                await userRole.save();
            }

            // Cấu hình Nodemailer với Mailtrap
            const transporter = nodemailer.createTransport({
                host: "sandbox.smtp.mailtrap.io",
                port: 2525,
                auth: {
                    user: "51e47aeaa8f169", 
                    pass: "58ed84a2ff95dd"  
                }
            });

            // Đọc file excel
            console.log("Bắt đầu đọc file Excel dạng Stream...");
            const workbook = new excel.Workbook();
            await workbook.xlsx.readFile(filepath);
            const sheet = workbook.worksheets[0];
            
            let bulkData = [];
            let mailPromises = [];
            let emptyCount = 0; 
            let successCount = 0;

            console.log("Bắt đầu duyệt từng dòng...");
            
            for (let i = 2; i <= sheet.rowCount; i++) {
                const row = sheet.getRow(i);
                const usernameRaw = row.getCell(1).value;
                const emailRaw = row.getCell(2).value;

                if (!usernameRaw || !emailRaw) {
                    emptyCount++;
                    if (emptyCount >= 10) break; // Thoát nếu 10 dòng rỗng
                    continue; 
                }

                emptyCount = 0;

                let finalUsername = usernameRaw.text ? usernameRaw.text : usernameRaw;
                let finalEmail = emailRaw.text ? emailRaw.text : emailRaw;

                // 1. Tạo password ngẫu nhiên 16 ký tự và Mã hóa luôn tại đây (vì insertMany bỏ qua .pre('save'))
                const randomPassword = crypto.randomBytes(8).toString('hex');
                const salt = bcrypt.genSaltSync(10);
                const hashedPassword = bcrypt.hashSync(randomPassword, salt);

                // 2. Gom dữ liệu vào túi (Batch)
                bulkData.push({
                    username: finalUsername,
                    email: finalEmail,
                    password: hashedPassword,
                    role: userRole._id,
                    plainPasswordForMail: randomPassword // Thuộc tính phụ để gửi email
                });

                // Nếu gom đủ 1000 dòng hoặc đến cuối file mới gọi DB 1 lần
                if (bulkData.length === 1000 || i === sheet.rowCount) {
                    console.log(`Đang Insert lô ${bulkData.length} records vào Database...`);
                    
                    try {
                        // insertMany với ordered=false: Lệnh siêu tốc. Thằng nào trùng (Lỗi E11000) nó bỏ qua, vứt hết phần còn lại vào DB thành công
                        let insertedDocs = await userModel.insertMany(bulkData, { ordered: false });
                        successCount += insertedDocs.length;
                    } catch (err) {
                        // Lỗi BulkWriteError thường xuất hiện nếu có chứa records bị trùng (Duplicate Key E11000)
                        if (err.insertedDocs) {
                            successCount += err.insertedDocs.length;
                        }
                    }

                    // 3. Chuẩn bị email gửi chạy ngầm KHÔNG KHÓA SERVER (Fire-and-forget)
                    for (let data of bulkData) {
                        const mailOptions = {
                            from: '"Hệ thống Sáng Thứ 3" <no-reply@domain.com>',
                            to: data.email,
                            subject: "Thông tin tài khoản và Mật khẩu đăng nhập",
                            html: `<p>Chào <b>${data.username}</b>,</p>
                                    <p>Tài khoản của bạn đã được tạo thành công.</p>
                                    <p>Mật khẩu đăng nhập của bạn: <b>${data.plainPasswordForMail}</b></p>`
                        };
                        
                        // Đẩy vào mảng Promise để nó tự Gửi mà Request Postman vẫn đi tiếp được
                        let sendTask = transporter.sendMail(mailOptions).catch(e => console.error("Lỗi gửi mail:", e.message));
                        mailPromises.push(sendTask);
                    }

                    // Dọn mảng để hứng lô tiếp theo
                    bulkData = []; 
                }
            }

            console.log(`Tiến trình Import hoàn tất vòng lặp. Đã quăng ${mailPromises.length} lệnh Gửi Email chạy ngầm.`);

            return {
                success: true,
                message: `Lệnh Import xử lý hoàn tất! Khoảng ${successCount} dữ liệu mới đã được nạp nhanh. Hệ thống đang tự động gửi Email ngầm...`
            };

        } catch (error) {
            console.error("Lỗi khi import user từ file:", error);
            return { success: false, error: "Lỗi Server", details: error.message };
        }
    }
}