export const ENCODINGS = [
    {
        "instructionId": "rax1_z_zz",
        "encodingId": "rax1_z_zz_",
        "mnemonic": "RAX1",
        "className": "SVE2",
        "fileName": "rax1_z_zz.xml",
        "mask": 4292934656,
        "value": 1159787520,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE_SHA3"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE_SHA3",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "rax1-z-zz"
    }
];
